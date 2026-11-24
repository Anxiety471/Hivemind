/**
 * Cross-language proof for Infrastructure C: the credential store (`v2:`
 * envelope), vault values (`rkz1:` under a vault's content key) and the
 * secret-persistence hook.
 *
 * TypeScript seals values with the shipped EncryptedSecretStore and the Go
 * binary (`cmd/secretsproof`) opens them; Go seals and TypeScript opens. The
 * failures (tampered, wrong record, wrong vault, missing key, wrong key) must
 * match. The hook is then exercised on both sides against the same database:
 * create, replace, delete, rollback, shared references, parent cascades — with
 * the change notifications captured from `rakazo_events` and compared, and the
 * row locks checked with a second connection.
 *
 * Run from a checkout with node_modules, test keys only:
 *   DATABASE_URL=... ENCRYPTION_KEY=test-key... ENCRYPTION_MASTER_KEYS=... \
 *   GO_PROOF_BIN=/tmp/infra-c/secretsproof \
 *   node_modules/.bin/tsx apps/api-go/tools/infra-c-proof.mts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createDecipheriv, createCipheriv, createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { PostgresRealtimeFanout } from "../../../packages/adapters/src/notifications/realtime.js";
import { EncryptedSecretStore } from "../../../packages/adapters/src/secrets/secrets.js";
import { withSecretPersistence } from "../../../packages/adapters/src/secrets/secret-persistence.js";
import { ComposedSecretStore } from "../../../packages/adapters/src/secrets/secret-store-factory.js";
import {
  openVaultValue,
  sealVaultValue,
} from "../../../packages/adapters/src/secrets/vault/vault-values.js";
import {
  asSystem,
  contentEncryptionOf,
  createDb,
  encryptText,
  runAsTenant,
} from "../../../packages/db/src/index.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
const GO_PROOF_BIN = process.env.GO_PROOF_BIN;
if (!GO_PROOF_BIN) throw new Error("GO_PROOF_BIN is required");
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY is required (a test key)");
process.env.CONTENT_ENCRYPTION ??= "on";

// ---------------------------------------------------------------- Go driver
const child = spawn(GO_PROOF_BIN, [], { stdio: ["pipe", "pipe", "inherit"] });
process.on("exit", () => child.kill());
const lines = createInterface({ input: child.stdout! });
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
let nextRequest = 0;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const waiter = pending.get(message.id);
  if (!waiter) throw new Error(`unexpected response id ${message.id}`);
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error));
  else waiter.resolve(message);
});
child.on("exit", (code) => {
  for (const waiter of pending.values()) waiter.reject(new Error(`go proof exited ${code}`));
  pending.clear();
});
function go(request: Record<string, unknown>): Promise<any> {
  const id = nextRequest++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin!.write(`${JSON.stringify({ ...request, id })}\n`);
  });
}
async function goError(request: Record<string, unknown>): Promise<string> {
  try {
    await go(request);
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}

// ---------------------------------------------------------------- database
const { prisma, pool } = createDb(DATABASE_URL);
const system = asSystem(prisma);
const encryption = contentEncryptionOf(prisma);
assert(encryption, "createDb must expose content encryption");
const ring = encryption.ring;

const encrypted = new EncryptedSecretStore(ENCRYPTION_KEY);
const fanout = new PostgresRealtimeFanout({ connectionString: DATABASE_URL, publisher: pool });
const secrets = new ComposedSecretStore(encrypted, undefined, fanout);
await secrets.start();
const persisted = withSecretPersistence(prisma, secrets);
const persistedSystem = asSystem(persisted);

const tag = `${Date.now().toString(36)}-${process.pid}`;
const id = (name: string) => `${name}-${tag}`;
let checks = 0;
async function check(name: string, body: () => void | Promise<void>) {
  await body();
  checks += 1;
  console.log(`ok ${name}`);
}
async function waitUntil(condition: () => boolean, label: string, timeoutMs = 5_000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const context = (userId: string, spaceId: string): any => ({
  operationId: "proof",
  traceId: "proof",
  userId,
  spaceId,
  signal: new AbortController().signal,
});

// ---------------------------------------------------------------- seeding
const user = { id: id("u"), name: "Secret Proof", email: `${id("u")}@example.test`, emailVerified: true };
const otherUser = {
  id: id("u2"),
  name: "Secret Proof Two",
  email: `${id("u2")}@example.test`,
  emailVerified: true,
};
const org = { id: id("org"), name: "Secret Proof Org", slug: id("org"), createdAt: new Date() };
const spaceA = id("sp-a");
const spaceB = id("sp-b");
const bot = { id: id("bot"), spaceId: spaceA, userId: user.id, name: "Proof Bot", color: "blue" };

await system.user.create({ data: user });
await system.user.create({ data: otherUser });
await system.organization.create({ data: org });
await system.member.create({
  data: { id: id("member"), organizationId: org.id, userId: user.id, role: "owner", createdAt: new Date() },
});
for (const [spaceId, name] of [
  [spaceA, "Space A"],
  [spaceB, "Space B"],
] as const) {
  await system.space.create({
    data: { id: spaceId, organizationId: org.id, name, isDefault: spaceId === spaceA },
  });
  await system.spaceMember.create({
    data: {
      id: `${spaceId}-m`,
      spaceId,
      organizationId: org.id,
      userId: user.id,
      role: "owner",
      createdAt: new Date(),
    },
  });
}
await system.bot.create({ data: bot });

// A second user with a Space, all cascaded by a parent delete later.
const cascadeUser = { id: id("u3"), name: "Cascade", email: `${id("u3")}@example.test`, emailVerified: true };
const cascadeSpace = id("sp-cascade");
await system.user.create({ data: cascadeUser });
await system.member.create({
  data: { id: id("member2"), organizationId: org.id, userId: otherUser.id, role: "member", createdAt: new Date() },
});
await system.member.create({
  data: { id: id("member3"), organizationId: org.id, userId: cascadeUser.id, role: "owner", createdAt: new Date() },
});
await system.space.create({
  data: { id: cascadeSpace, organizationId: org.id, name: "Cascade Space", isDefault: false },
});
await system.spaceMember.create({
  data: {
    id: `${cascadeSpace}-m`,
    spaceId: cascadeSpace,
    organizationId: org.id,
    userId: cascadeUser.id,
    role: "owner",
    createdAt: new Date(),
  },
});

// ---------------------------------------------------------------- listener
const listener = await pool.connect();
const events: Array<{ topic: string; ref: string; origin: string }> = [];
listener.on("notification", (notification: any) => {
  if (!notification.payload) return;
  const outer = JSON.parse(notification.payload);
  if (outer.topic !== "secret-store-change") return;
  events.push({ topic: outer.topic, ...JSON.parse(outer.payload) });
});
await listener.query("LISTEN rakazo_events");
// PostgreSQL delivers NOTIFY asynchronously, so a mark waits for the events a
// previous step published before it records the boundary.
async function mark(): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return events.length;
}
async function expectEvents(
  from: number,
  expected: string[],
  label: string,
  settleMs = 400,
) {
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const seen = events.slice(from);
  assert.equal(seen.length, expected.length, `${label}: event count`);
  for (let index = 0; index < expected.length; index += 1) {
    assert.equal(seen[index]!.ref, expected[index], `${label}: event ${index} ref`);
    assert.equal(seen[index]!.topic, "secret-store-change", `${label}: topic`);
    assert.match(seen[index]!.origin, /^[0-9a-f-]{36}$/, `${label}: origin`);
  }
}

const values = {
  ascii: "hello world",
  unicode: "İstanbul 😀 中文 é",
  empty: "",
  markup: "<&> \"quoted\" \\backslash",
  long: "x".repeat(4096),
  nul: "before\u0000after",
};

// ------------------------------------------------- 1. envelope interop
for (const [name, value] of Object.entries(values)) {
  await check(`ts-seal/go-open ${name}`, async () => {
    const record = await encrypted.put(value, context(user.id, spaceA), { recordId: "row-a" });
    assert.match(record.ref, /^v2:/);
    const opened = await go({ op: "open", ref: record.ref, recordId: "row-a" });
    assert.equal(opened.plaintext, value);
  });
}
for (const [name, value] of Object.entries(values)) {
  await check(`go-seal/ts-open ${name}`, async () => {
    const sealed = await go({ op: "seal", plaintext: value, recordId: "row-b" });
    assert.match(sealed.ref, /^v2:/);
    assert.equal(await encrypted.load(sealed.ref, "row-b"), value);
  });
}

await check("lone surrogate becomes U+FFFD on both sides", async () => {
  const record = await encrypted.put("a\ud800b", context(user.id, spaceA), { recordId: "row-surrogate" });
  const goOpened = await go({ op: "open", ref: record.ref, recordId: "row-surrogate" });
  const tsOpened = await encrypted.load(record.ref, "row-surrogate");
  assert.equal(tsOpened, "a\ufffdb");
  assert.equal(goOpened.plaintext, tsOpened);
});

await check("fresh record id is 12 random bytes as 24 hex chars", async () => {
  const record = await encrypted.put("value", context(user.id, spaceA));
  const sealed = await go({ op: "seal-new", plaintext: "value" });
  assert.match(record.id, /^[0-9a-f]{24}$/);
  assert.match(sealed.recordId, /^[0-9a-f]{24}$/);
  assert.notEqual(record.id, sealed.recordId);
});

await check("legacy ts-seal/go-open and go-seal/ts-open", async () => {
  const legacy = legacySeal("legacy value İ");
  const opened = await go({ op: "open", ref: legacy, recordId: "any" });
  assert.equal(opened.plaintext, "legacy value İ");
  const goLegacy = await go({ op: "legacy-seal", plaintext: "go legacy 😀" });
  assert.equal(await encrypted.load(goLegacy.ref, "any"), "go legacy 😀");
});

await check("wrong record id fails identically", async () => {
  const record = await encrypted.put("bound", context(user.id, spaceA), { recordId: "row-one" });
  const goMessage = await goError({ op: "open", ref: record.ref, recordId: "row-two" });
  assert.match(goMessage, /unable to authenticate/);
  await assert.rejects(encrypted.load(record.ref, "row-two"), /unable to authenticate/);
});

await check("tampered body fails identically", async () => {
  const record = await encrypted.put("tamper me", context(user.id, spaceA), { recordId: "row-t" });
  const body = record.ref.slice("v2:".length);
  const at = Math.floor(body.length / 2);
  const replacement = body[at] === "A" ? "B" : "A";
  const tampered = `v2:${body.slice(0, at)}${replacement}${body.slice(at + 1)}`;
  const goMessage = await goError({ op: "open", ref: tampered, recordId: "row-t" });
  assert.match(goMessage, /unable to authenticate/);
  await assert.rejects(encrypted.load(tampered, "row-t"), /unable to authenticate/);
});

await check("malformed values fail identically", async () => {
  for (const bad of ["v2:", "v2:AAAA", "v2:AAAA===="]) {
    const goMessage = await goError({ op: "open", ref: bad, recordId: "row" });
    assert.equal(goMessage, "Encrypted secret is malformed", `${bad} on Go`);
    await assert.rejects(encrypted.load(bad, "row"), /Encrypted secret is malformed/, `${bad} on TS`);
  }
});

await check("a different key fails on both sides", async () => {
  const record = await encrypted.put("private", context(user.id, spaceA), { recordId: "row-k" });
  const goMessage = await goError({
    op: "open",
    ref: record.ref,
    recordId: "row-k",
    keyId: "another-key-entirely",
  });
  assert.match(goMessage, /unable to authenticate/);
  const other = new EncryptedSecretStore("another-key-entirely");
  await assert.rejects(other.load(record.ref, "row-k"), /unable to authenticate/);
});

await check("node base64 leniency opens padded, junked and alphabet-rewritten bodies", async () => {
  const record = await encrypted.put("lenient İ 😀", context(user.id, spaceA), { recordId: "row-l" });
  const body = record.ref.slice("v2:".length);
  const variants = [
    `${body}==`,
    `${body.slice(0, 4)}!!${body.slice(4)}`,
    body.replaceAll("+", "-").replaceAll("/", "_"),
  ];
  for (const variant of variants) {
    const opened = await go({ op: "open", ref: `v2:${variant}`, recordId: "row-l" });
    assert.equal(opened.plaintext, "lenient İ 😀");
    assert.equal(await encrypted.load(`v2:${variant}`, "row-l"), "lenient İ 😀");
  }
});

await check("redaction matches", async () => {
  const samples = [
    "key sk-abcdefgh1234 here",
    "bearer eyJhbGciOi.eyJzdWIi.sig_part",
    "sk-short",
    "nothing to hide",
  ];
  for (const sample of samples) {
    const goRedacted = await go({ op: "redact", value: sample });
    assert.equal(goRedacted.redacted, encrypted.redact(sample), sample);
  }
});

// ------------------------------------------------- 2. vault values
const vaultUserScope = `user:${user.id}`;
const vaultSpaceScope = `vault:${spaceA}`;
const vaultKeyUser = await ring.current(vaultUserScope);
const vaultKeySpace = await ring.current(vaultSpaceScope);

await check("ts vault seal (rkz1 under the vault key) / go open", async () => {
  const row = { id: id("vault-user"), userId: user.id, spaceId: null };
  const sealed = await sealVaultValue(persisted, secrets, row, "login İ 😀", context(user.id, spaceA));
  assert.ok(sealed.startsWith("rkz1:"), "must use the vault key once one exists");
  const opened = await go({
    op: "vault-open",
    value: sealed,
    row: { id: row.id, userId: user.id, spaceId: null },
  });
  assert.equal(opened.plaintext, "login İ 😀");
});

await check("go vault seal / ts open", async () => {
  const rowID = id("vault-space");
  const sealed = await go({
    op: "vault-seal",
    plaintext: "space vault value",
    row: { id: rowID, userId: user.id, spaceId: spaceA },
  });
  assert.ok(sealed.ciphertext.startsWith(`rkz1:${vaultKeySpace.id}:`), "names the newest vault key");
  const row = { id: rowID, userId: user.id, spaceId: spaceA };
  assert.equal(await openVaultValue(persisted, secrets, { ...row, ciphertext: sealed.ciphertext }), "space vault value");
  // The same value opened with a row of another owner must fail.
  await assert.rejects(
    openVaultValue(persisted, secrets, { ...row, id: id("other-row"), ciphertext: sealed.ciphertext }),
  );
});

await check("no vault key falls back to the store format, and both sides open it", async () => {
  const freshUser = id("u-fresh");
  const row = { id: id("vault-fresh"), userId: freshUser, spaceId: null };
  const sealed = await sealVaultValue(persisted, secrets, row, "before the key", context(user.id, spaceA));
  assert.ok(sealed.startsWith("v2:"), "no key yet: the previous format");
  const opened = await go({
    op: "vault-open",
    value: sealed,
    row: { id: row.id, userId: freshUser, spaceId: null },
  });
  assert.equal(opened.plaintext, "before the key");
});

await check("a value under another vault's key is refused", async () => {
  const otherKey = await ring.current(`user:${otherUser.id}`);
  const row = { id: id("vault-cross"), userId: otherUser.id, spaceId: null };
  const sealed = await sealVaultValue(persisted, secrets, row, "other vault", context(user.id, spaceA));
  assert.ok(sealed.startsWith(`rkz1:${otherKey.id}:`), "sealed under the other user's key");
  const goMessage = await goError({
    op: "vault-open",
    value: sealed,
    row: { id: row.id, userId: user.id, spaceId: null },
  });
  assert.equal(goMessage, "Vault item names another vault's key");
  await assert.rejects(
    openVaultValue(persisted, secrets, { ...row, userId: user.id, ciphertext: sealed }),
    /another vault's key/,
  );
});

await check("a ciphertext naming a missing key is reported identically", async () => {
  const otherKey = await ring.current(`user:${otherUser.id}`);
  const row = { id: id("vault-missing"), userId: otherUser.id, spaceId: null };
  const sealed = await sealVaultValue(persisted, secrets, row, "key then gone", context(user.id, spaceA));
  assert.ok(sealed.startsWith(`rkz1:${otherKey.id}:`));
  // A key id no space_keys row carries, as a shredded vault leaves behind.
  const missingKey = `c${randomBytes(12).toString("hex")}`;
  const orphaned = sealed.replace(/^rkz1:[^:]+:/, `rkz1:${missingKey}:`);
  const goMessage = await goError({
    op: "vault-open",
    value: orphaned,
    row: { id: row.id, userId: otherUser.id, spaceId: null },
  });
  assert.equal(goMessage, "Vault item names a key that no longer exists");
  await assert.rejects(
    openVaultValue(persisted, secrets, { ...row, ciphertext: orphaned }),
    /no longer exists/,
  );
});

await check("bot-secret values use the vault location and cross open", async () => {
  // The shipped helper binds a bot secret to the vault_credentials location;
  // Go must produce and accept exactly that binding.
  const rowID = id("bot-secret");
  const row = { id: rowID, userId: user.id, spaceId: null };
  const tsSealed = await sealVaultValue(persisted, secrets, row, "bot secret", context(user.id, spaceA));
  const goRow = { id: rowID, userId: user.id, spaceId: null };
  const goOpened = await go({ op: "vault-open", value: tsSealed, row: goRow });
  assert.equal(goOpened.plaintext, "bot secret");
  const goSealed = await go({ op: "vault-seal", plaintext: "bot secret 2", row: goRow });
  assert.equal(
    await openVaultValue(persisted, secrets, { ...row, ciphertext: goSealed.ciphertext }),
    "bot secret 2",
  );
});

await check("the vault key's newest version seals", async () => {
  const newest = await ring.rotate(vaultSpaceScope);
  const row = { id: id("vault-rotated"), userId: user.id, spaceId: spaceA };
  const sealed = await sealVaultValue(persisted, secrets, row, "after rotation", context(user.id, spaceA));
  assert.ok(sealed.startsWith(`rkz1:${newest.id}:`), "must name the rotated key");
  const goOpened = await go({
    op: "vault-open",
    value: sealed,
    row: { id: row.id, userId: user.id, spaceId: spaceA },
  });
  assert.equal(goOpened.plaintext, "after rotation");
  // Older values keep opening.
  assert.equal(
    await openVaultValue(persisted, secrets, {
      id: id("old"),
      userId: user.id,
      spaceId: spaceA,
      ciphertext: await sealUnder(vaultKeySpace, {
        id: id("old"),
        userId: user.id,
        spaceId: spaceA,
      }, "old key value"),
    }),
    "old key value",
  );
});

/** Seals under a specific key without the newest-version lookup. */
async function sealUnder(key: any, row: any, plaintext: string) {
  return encryptText(
    key,
    { table: "vault_credentials", column: "ciphertext", rowId: row.id, owner: row.userId },
    plaintext,
  );
}

// ------------------------------------------------- 3. hook side effects
async function tsCreate(itemID: string, kind: string, value: string, actor = { userId: user.id, spaceId: spaceA }) {
  const record = await secrets.put(value, context(actor.userId, actor.spaceId), { recordId: itemID });
  await runAsTenant({ userId: actor.userId, spaceId: actor.spaceId } as any, () =>
    persisted.secret.create({
      data: { id: itemID, userId: actor.userId, spaceId: actor.spaceId, kind, ciphertext: record.ciphertext },
    }),
  );
  return record;
}

await check("create: one change notification, row present", async () => {
  const itemID = id("h-create");
  let from = await mark();
  const ts = await tsCreate(itemID, "webhook", "create value");
  await expectEvents(from, [ts.ref], "ts create");
  assert.equal(await encrypted.load(ts.ref, ts.id), "create value");

  from = await mark();
  const goRecord = await go({
    op: "secret-create",
    itemId: itemID + "-go",
    plaintext: "create value",
    kind: "webhook",
    userId: user.id,
    spaceId: spaceA,
  });
  await expectEvents(from, [goRecord.ref], "go create");
  const state = await go({ op: "row-state", itemId: itemID + "-go" });
  assert.equal(state.present, true);
});

await check("delete: one change notification, row gone", async () => {
  const tsItem = id("h-del-ts");
  const ts = await tsCreate(tsItem, "webhook", "delete value");
  let from = await mark();
  await runAsTenant({ userId: user.id, spaceId: spaceA } as any, () =>
    persisted.secret.deleteMany({ where: { id: tsItem } }),
  );
  await expectEvents(from, [ts.ref], "ts delete");
  assert.equal(await system.secret.count({ where: { id: tsItem } }), 0);

  const goItem = id("h-del-go");
  const goRecord = await go({
    op: "secret-create", itemId: goItem, plaintext: "delete value", kind: "webhook",
    userId: user.id, spaceId: spaceA,
  });
  from = await mark();
  const deleted = await go({
    op: "secret-delete", itemId: goItem, userId: user.id, spaceId: spaceA,
  });
  await expectEvents(from, [goRecord.ref], "go delete");
  assert.deepEqual(deleted.refs, [goRecord.ref]);
  const state = await go({ op: "row-state", itemId: goItem });
  assert.equal(state.present, false);
});

await check("replace: new value announced first, the dropped ref after commit", async () => {
  const tsItem = id("h-upd-ts");
  const first = await tsCreate(tsItem, "webhook", "first");
  let from = await mark();
  const second = await secrets.put("second", context(user.id, spaceA), { recordId: tsItem });
  await runAsTenant({ userId: user.id, spaceId: spaceA } as any, () =>
    persisted.secret.update({ where: { id: tsItem }, data: { ciphertext: second.ciphertext } }),
  );
  await expectEvents(from, [second.ref, first.ref], "ts update");

  const goItem = id("h-upd-go");
  const goFirst = await go({
    op: "secret-create", itemId: goItem, plaintext: "first", kind: "webhook",
    userId: user.id, spaceId: spaceA,
  });
  from = await mark();
  const goSecond = await go({
    op: "secret-update", itemId: goItem, plaintext: "second", userId: user.id, spaceId: spaceA,
  });
  await expectEvents(from, [goSecond.ref, goFirst.ref], "go update");
  assert.equal(goSecond.oldRef, goFirst.ref);
});

await check("create rollback announces the written and then the unsaved ref", async () => {
  const tsItem = id("h-rb-ts");
  let from = await mark();
  const record = await secrets.put("rollback value", context(user.id, spaceA), { recordId: tsItem });
  await runAsTenant({ userId: user.id, spaceId: spaceA } as any, async () => {
    await assert.rejects(
      persisted.$transaction(async (tx: any) => {
        await tx.secret.create({
          data: { id: tsItem, userId: user.id, spaceId: spaceA, kind: "webhook", ciphertext: record.ciphertext },
        });
        throw new Error("proof rollback");
      }),
      /proof rollback/,
    );
  });
  await expectEvents(from, [record.ref, record.ref], "ts create rollback");
  assert.equal(await system.secret.count({ where: { id: tsItem } }), 0);

  const goItem = id("h-rb-go");
  from = await mark();
  const goRecord = await go({
    op: "secret-create-rollback", itemId: goItem, plaintext: "rollback value", kind: "webhook",
    userId: user.id, spaceId: spaceA,
  });
  await expectEvents(from, [goRecord.ref, goRecord.ref], "go create rollback");
  const state = await go({ op: "row-state", itemId: goItem });
  assert.equal(state.present, false);
});

await check("a create refused by the row announces its written ref as unsaved", async () => {
  // Tracking must happen before the INSERT: a duplicate id fails the insert,
  // and the ref sealed for it is still cleaned (secret-persistence.ts:226-247).
  const tsItem = id("h-dup-ts");
  await tsCreate(tsItem, "webhook", "first");
  let from = await mark();
  const duplicate = await secrets.put("second", context(user.id, spaceA), { recordId: tsItem });
  await runAsTenant({ userId: user.id, spaceId: spaceA } as any, () =>
    assert.rejects(
      persisted.$transaction(async (tx: any) => {
        await tx.secret.create({
          data: { id: tsItem, userId: user.id, spaceId: spaceA, kind: "webhook", ciphertext: duplicate.ciphertext },
        });
      }),
      /Unique constraint|unique constraint/,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  const tsSeen = events.slice(from);
  assert.equal(tsSeen.length, 2, "ts duplicate create: event count");
  assert.equal(tsSeen[0]!.ref, duplicate.ref);
  assert.equal(tsSeen[1]!.ref, duplicate.ref);

  const goItem = id("h-dup-go");
  await go({
    op: "secret-create", itemId: goItem, plaintext: "first", kind: "webhook",
    userId: user.id, spaceId: spaceA,
  });
  from = await mark();
  const failed = await goError({
    op: "secret-create", itemId: goItem, plaintext: "second", kind: "webhook",
    userId: user.id, spaceId: spaceA,
  });
  assert.match(failed, /duplicate key|unique constraint/i);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const goSeen = events.slice(from);
  assert.equal(goSeen.length, 2, "go duplicate create: event count");
  assert.equal(goSeen[0]!.ref, goSeen[1]!.ref);
});

await check("delete rollback announces nothing and keeps the row", async () => {
  const tsItem = id("h-drb-ts");
  await tsCreate(tsItem, "webhook", "kept");
  let from = await mark();
  await runAsTenant({ userId: user.id, spaceId: spaceA } as any, () =>
    assert.rejects(
      persisted.$transaction(async (tx: any) => {
        await tx.secret.deleteMany({ where: { id: tsItem } });
        throw new Error("proof rollback");
      }),
      /proof rollback/,
    ),
  );
  await expectEvents(from, [], "ts delete rollback");
  assert.equal(await system.secret.count({ where: { id: tsItem } }), 1);

  const goItem = id("h-drb-go");
  await go({
    op: "secret-create", itemId: goItem, plaintext: "kept", kind: "webhook",
    userId: user.id, spaceId: spaceA,
  });
  from = await mark();
  await go({ op: "secret-delete-rollback", itemId: goItem, userId: user.id, spaceId: spaceA });
  await expectEvents(from, [], "go delete rollback");
  const state = await go({ op: "row-state", itemId: goItem });
  assert.equal(state.present, true);
});

await check("two rows sharing a ref: one delete announces nothing while the other holds it", async () => {
  const tsItem = id("h-share-ts");
  const record = await tsCreate(tsItem, "webhook", "shared");
  // A second row with the same ciphertext, in another table kind.
  await system.secret.create({
    data: { id: `${tsItem}-2`, userId: user.id, spaceId: spaceA, kind: "mcp", ciphertext: record.ciphertext },
  });
  let from = await mark();
  await runAsTenant({ userId: user.id, spaceId: spaceA } as any, () =>
    persisted.secret.deleteMany({ where: { id: tsItem } }),
  );
  await expectEvents(from, [], "ts shared ref held");
  await runAsTenant({ userId: user.id, spaceId: spaceA } as any, () =>
    persisted.secret.deleteMany({ where: { id: `${tsItem}-2` } }),
  );
  await expectEvents(from, [record.ref], "ts shared ref last holder");

  const goItem = id("h-share-go");
  const goRecord = await go({
    op: "secret-create", itemId: goItem, plaintext: "shared", kind: "webhook",
    userId: user.id, spaceId: spaceA,
  });
  await system.secret.create({
    data: { id: `${goItem}-2`, userId: user.id, spaceId: spaceA, kind: "mcp", ciphertext: goRecord.ref },
  });
  from = await mark();
  await go({ op: "secret-delete", itemId: goItem, userId: user.id, spaceId: spaceA });
  await expectEvents(from, [], "go shared ref held");
  await go({ op: "secret-delete", itemId: `${goItem}-2`, userId: user.id, spaceId: spaceA });
  await expectEvents(from, [goRecord.ref], "go shared ref last holder");
});

await check("deleting a Space cascades to its secrets, vault items and bot secrets", async () => {
  // TS: seed a Space with three references in different tables, delete it
  // through the hook in a tenant transaction.
  const space = id("h-space");
  const spaceUser = id("u-space");
  await system.user.create({ data: { id: spaceUser, name: "Space User", email: `${spaceUser}@x.test`, emailVerified: true } });
  await system.member.create({
    data: { id: `${spaceUser}-member`, organizationId: org.id, userId: spaceUser, role: "owner", createdAt: new Date() },
  });
  await system.space.create({ data: { id: space, organizationId: org.id, name: "Delete me", isDefault: false } });
  await system.spaceMember.create({
    data: { id: `${space}-m`, spaceId: space, organizationId: org.id, userId: spaceUser, role: "owner", createdAt: new Date() },
  });
  const secretRow = await encrypted.put("space secret", context(spaceUser, space), { recordId: id("sp-secret") });
  await system.secret.create({
    data: { id: secretRow.id, userId: spaceUser, spaceId: space, kind: "webhook", ciphertext: secretRow.ciphertext },
  });
  const vaultRow = await encrypted.put("space vault", context(spaceUser, space), { recordId: id("sp-vault") });
  await system.vaultCredential.create({
    data: {
      id: vaultRow.id, userId: spaceUser, spaceId: space, name: "item", origin: "https://example.test",
      auth: { type: "value" }, ciphertext: vaultRow.ciphertext,
    },
  });
  const botRow = await encrypted.put("space bot secret", context(spaceUser, space), { recordId: id("sp-bot") });
  await system.bot.create({
    data: { id: id("sp-bot-row"), spaceId: space, userId: spaceUser, name: "Space Bot", color: "green" },
  });
  await system.botSecret.create({
    data: {
      id: botRow.id, userId: spaceUser, spaceId: space, botId: id("sp-bot-row"), name: "login",
      origin: "https://example.test", auth: { type: "value" }, ciphertext: botRow.ciphertext,
    },
  });
  let from = await mark();
  await asSystem(persisted).space.delete({ where: { id: space } });
  await expectEvents(
    from,
    [secretRow.ref, vaultRow.ref, botRow.ref],
    "ts space cascade",
    600,
  );

  // Go: same shape, deleted through the hook's parent path.
  const goSpace = id("h-space-go");
  const goUser = id("u-space-go");
  await system.user.create({ data: { id: goUser, name: "Go Space User", email: `${goUser}@x.test`, emailVerified: true } });
  await system.member.create({
    data: { id: `${goUser}-member`, organizationId: org.id, userId: goUser, role: "owner", createdAt: new Date() },
  });
  await system.space.create({ data: { id: goSpace, organizationId: org.id, name: "Go delete me", isDefault: false } });
  await system.spaceMember.create({
    data: { id: `${goSpace}-m`, spaceId: goSpace, organizationId: org.id, userId: goUser, role: "owner", createdAt: new Date() },
  });
  const goSecret = await go({
    op: "secret-create", itemId: id("gsp-secret"), plaintext: "space secret", kind: "webhook",
    userId: goUser, spaceId: goSpace,
  });
  const goVaultRow = id("gsp-vault");
  await go({ op: "key-current", scope: `vault:${goSpace}` });
  const goVault = await go({
    op: "vault-seal", plaintext: "space vault",
    row: { id: goVaultRow, userId: goUser, spaceId: goSpace },
  });
  assert.ok(goVault.ciphertext.startsWith("rkz1:"), "the space vault key seals it");
  await system.vaultCredential.create({
    data: {
      id: goVaultRow, userId: goUser, spaceId: goSpace, name: "item", origin: "https://example.test",
      auth: { type: "value" }, ciphertext: goVault.ciphertext,
    },
  });
  const goBot = await go({
    op: "secret-create", itemId: id("gsp-bot"), plaintext: "space bot secret", kind: "bot",
    userId: goUser, spaceId: goSpace,
  });
  // The bot secret's own table: one Bot row and a bot_secrets row sharing the ref.
  const goBotRow = id("gsp-bot-row");
  await system.bot.create({ data: { id: goBotRow, spaceId: goSpace, userId: goUser, name: "Go Bot", color: "green" } });
  await system.botSecret.create({
    data: {
      id: id("gsp-bot-secret"), userId: goUser, spaceId: goSpace, botId: goBotRow, name: "login",
      origin: "https://example.test", auth: { type: "value" }, ciphertext: goBot.ref,
    },
  });
  from = await mark();
  const cascade = await go({
    op: "parent-delete", model: "Space", parentId: goSpace, userId: user.id, spaceId: spaceA,
  });
  await expectEvents(from, [goBot.ref, goSecret.ref, goVault.ciphertext], "go space cascade", 600);
  assert.deepEqual(
    [...new Set(cascade.refs)].sort(),
    [goSecret.ref, goVault.ciphertext, goBot.ref].sort(),
  );
});

await check("deleting a User cascades across the tenants the cascade cannot see", async () => {
  const cascadeSecret = await go({
    op: "secret-create", itemId: id("cu-secret"), plaintext: "cascade user secret", kind: "webhook",
    userId: cascadeUser.id, spaceId: cascadeSpace,
  });
  let from = await mark();
  const cascade = await go({
    op: "parent-delete", model: "User", parentId: cascadeUser.id, userId: user.id, spaceId: spaceA,
  });
  await expectEvents(from, [cascadeSecret.ref], "go user cascade", 600);
  assert.deepEqual(cascade.refs, [cascadeSecret.ref]);
});

await check("no secret cleanup jobs are recorded for inline references", async () => {
  const tsJobs = await system.$queryRaw<any[]>`
    SELECT count(*)::int AS count FROM graphile_worker._private_jobs WHERE payload->>'kind' IS NOT NULL`;
  assert.equal(tsJobs[0].count, 0);
  const goJobs = await go({ op: "jobs-count" });
  assert.equal(goJobs.count ?? 0, 0);
});

// ------------------------------------------------- 4. ordering and locks
await check("the hook holds FOR UPDATE locks from capture to commit", async () => {
  const tsItem = id("h-lock-ts");
  const tsRecord = await tsCreate(tsItem, "webhook", "locked");
  let during = "";
  let from = await mark();
  await runAsTenant({ userId: user.id, spaceId: spaceA } as any, () =>
    persisted.$transaction(async (tx: any) => {
      await tx.secret.deleteMany({ where: { id: tsItem } });
      during = await persistedSystem.$transaction(async (probe: any) => {
        try {
          await probe.$queryRaw`SELECT id FROM secrets WHERE id = ${tsItem} FOR UPDATE NOWAIT`;
          return "ok";
        } catch {
          return "blocked";
        }
      });
    }),
  );
  const after = await persistedSystem.$transaction(async (probe: any) => {
    try {
      await probe.$queryRaw`SELECT id FROM secrets WHERE id = ${tsItem} FOR UPDATE NOWAIT`;
      return "ok";
    } catch {
      return "blocked";
    }
  });
  assert.equal(during, "blocked", "TS holds the lock during the transaction");
  assert.equal(after, "ok");
  await expectEvents(from, [tsRecord.ref], "ts lock probe");

  const goItem = id("h-lock-go");
  await go({
    op: "secret-create", itemId: goItem, plaintext: "locked", kind: "webhook",
    userId: user.id, spaceId: spaceA,
  });
  const probe = await go({
    op: "lock-probe", itemId: goItem, userId: user.id, spaceId: spaceA, pauseMs: 50,
  });
  assert.equal(probe.during, "blocked", "Go holds the lock during the transaction");
  assert.equal(probe.after, "ok");
});

await check("cleanup runs after the commit, never before", async () => {
  // A listener that reads the row at notification time: the delete's commit has
  // already happened, so the row must be gone even though the hook is the one
  // announcing.
  const itemID = id("h-order");
  const created = await tsCreate(itemID, "webhook", "order");
  let observed: boolean | null = null;
  const watcher = await pool.connect();
  try {
    await watcher.query("LISTEN rakazo_events");
    const seen = new Promise<void>((resolve) => {
      watcher.on("notification", async (notification: any) => {
        const outer = JSON.parse(notification.payload);
        if (outer.topic !== "secret-store-change") return;
        const inner = JSON.parse(outer.payload);
        if (inner.ref !== created.ref) return;
        const row = await system.secret.findUnique({ where: { id: itemID } });
        observed = row !== null;
        resolve();
      });
    });
    await runAsTenant({ userId: user.id, spaceId: spaceA } as any, () =>
      persisted.secret.deleteMany({ where: { id: itemID } }),
    );
    await seen;
  } finally {
    watcher.release();
  }
  assert.equal(observed, false, "the row was gone when its cleanup was announced");
});

// ---------------------------------------------------------------- finish
listener.release();
await secrets.close();
await pool.end();

console.log(`PASS ${checks} checks`);
process.exit(0);

// ---------------------------------------------------------------- helpers
function legacySeal(plaintext: string): string {
  const key = createHash("sha256").update(ENCRYPTION_KEY!).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}
