/**
 * Cross-language proof for Infrastructure A: rkz1 content encryption and the
 * product-event append path. TypeScript seals every ENCRYPTED_MODELS column and
 * Go opens it byte-identically; Go seals and TypeScript opens; both agree on
 * blind-index tokens and on every failure (wrong AAD, wrong key, wrong space,
 * tampering). Then both append to one thread, interleaved and concurrently,
 * and a LISTEN capture must show gap-free seqs and identical notify envelopes.
 *
 * Run from the deployed checkout, which has node_modules, with test keys only:
 *   cd /home/bocchi/apps/rakazo
 *   DATABASE_URL=... ENCRYPTION_KEY=test-key... ENCRYPTION_MASTER_KEYS=... \
 *   GO_PROOF_BIN=/tmp/lane-e/infraproof \
 *   node_modules/.bin/tsx apps/api-go/tools/infra-a-proof.mts
 *
 * The Go binary is cmd/infraproof in apps/api-go; it speaks one JSON request
 * per line and one response per line.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  asSystem,
  contentEncryptionOf,
  createDb,
  decryptText,
  encryptText,
  readRunTimingFields,
} from "../../../packages/db/src/index.js";
import { appendEvent } from "../../../packages/db/src/events.js";
import { sanitizeJsonValue } from "../../../packages/core/src/events.js";
import { PostgresRealtimeFanout } from "../../../packages/adapters/src/realtime.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
const GO_PROOF_BIN = process.env.GO_PROOF_BIN;
if (!GO_PROOF_BIN) throw new Error("GO_PROOF_BIN is required");
if (!process.env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY is required (a test key)");
process.env.CONTENT_ENCRYPTION ??= "on";

// ---------------------------------------------------------------- Go driver
const child = spawn(GO_PROOF_BIN, [], {
  stdio: ["pipe", "pipe", "inherit"],
  // The key-rotation check waits this out instead of the ten-minute default.
  env: { ...process.env, GO_PROOF_KEY_TTL_MS: process.env.GO_PROOF_KEY_TTL_MS ?? "1000" },
});
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
const { prisma, pool, contentKeys } = createDb(DATABASE_URL);
const system = asSystem(prisma);
const encryption = contentEncryptionOf(prisma);
assert(encryption, "createDb must expose content encryption");
const tag = `${Date.now().toString(36)}-${process.pid}`;
const id = (name: string) => `${name}-${tag}`;
let checks = 0;
function check(name: string, body: () => void | Promise<void>) {
  const run = async () => {
    await body();
    checks += 1;
    console.log(`ok ${name}`);
  };
  return run();
}

const user = { id: id("u"), name: "Proof User", email: `${id("u")}@example.test`, emailVerified: true };
const org = { id: id("org"), name: "Proof Org", slug: id("org"), createdAt: new Date() };
const spaceA = id("sp-a");
const spaceB = id("sp-b");
// spaceC starts with no content key: Go creates it, TS rotates it.
const spaceC = id("sp-c");
const bot = { id: id("bot"), spaceId: spaceA, userId: user.id, name: "Proof Bot", color: "blue" };
const bot2 = { id: id("bot2"), spaceId: spaceA, userId: user.id, name: "Proof Bot 2", color: "red" };
const threadA = id("th");
const docA = { id: id("doc"), spaceId: spaceA, userId: user.id, scope: "space", path: "MEMORY.md" };
const docB = { id: id("doc-b"), spaceId: spaceB, userId: user.id, scope: "space", path: "MEMORY.md" };

const summary = "Compacted history: Pelican İstanbul 😀 <&> summary";
const blocks = [
  { kind: "text", status: "done", text: "Pelican İstanbul 😀 report", extra: 1 },
  { kind: "steps", steps: [{ label: "Search the web", note: "found pelican" }, { label: "Read file" }] },
  { kind: "file", artifactId: "art-1", name: "photo.png", size: 10 },
  { kind: "subagent", task: "Summarize", result: "done" },
];
const blocksSecond = [
  { kind: "text", text: "", status: "sent" },
  { kind: "steps", steps: [{ label: "Only a label" }] },
];
const toolHistory = JSON.stringify({ calls: [{ name: "search", arguments: { q: "pelican" } }] });
const eventPayload = {
  messageId: "msg-1",
  notice: "a notice",
  state: "done",
  updatedAt: "2026-11-19T00:00:00.000Z",
  streaming: false,
  blocks: [{ kind: "text", text: "event body <&>" }],
};
const contentA = "# Memory\n\nPelican facts İ 😀";
const contentB = "Space B memory, another key";
const revisionContent = "revision one <&>";
const email = {
  fromAddress: "bot@example.test",
  fromName: "Proof Bot",
  subject: "Subject İ",
  text: "Body text with pelican 😀",
};

// ---------------------------------------------------------------- seeding
await system.user.create({ data: user });
await system.organization.create({ data: org });
await system.member.create({
  data: { id: id("member"), organizationId: org.id, userId: user.id, role: "owner", createdAt: new Date() },
});
for (const [spaceId, name, isDefault] of [
  [spaceA, "Space A", true],
  [spaceB, "Space B", false],
  [spaceC, "Space C", false],
] as const) {
  await system.space.create({ data: { id: spaceId, organizationId: org.id, name, isDefault } });
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
await system.bot.create({ data: bot2 });
await system.thread.create({
  data: { id: threadA, spaceId: spaceA, userId: user.id, botId: bot.id, historyCompactionSummary: summary },
});
await system.memoryDocument.create({ data: { ...docA, content: contentA, updatedAt: new Date() } });
await system.memoryDocument.create({ data: { ...docB, content: contentB, updatedAt: new Date() } });
await system.memoryRevision.create({
  data: { id: id("rev"), documentId: docA.id, revision: 1, content: revisionContent },
});
await system.message.create({
  data: {
    id: id("m1"),
    threadId: threadA,
    seq: 10,
    role: "user",
    blocks,
    toolHistory,
  },
});
await system.message.create({
  data: { id: id("m2"), threadId: threadA, seq: 11, role: "bot", blocks: blocksSecond },
});
await system.event.create({
  data: {
    id: id("ev"),
    spaceId: spaceA,
    threadId: threadA,
    botId: bot.id,
    seq: 100,
    type: "thread.meta",
    payload: eventPayload,
  },
});
await system.botEmailMessage.create({
  data: {
    id: id("mail"),
    spaceId: spaceA,
    botId: bot.id,
    key: id("mail-key"),
    references: [],
    to: ["user@example.test"],
    cc: [],
    verified: true,
    attachments: [],
    ...email,
  },
});

// Every encrypted model and column, with the context each ciphertext binds.
const modelRows = [
  {
    model: "Thread",
    table: "threads",
    fields: ["historyCompactionSummary"],
    owner: user.id,
    sql: `SELECT id, "spaceId", "userId", "historyCompactionSummary" FROM threads WHERE id = $1`,
    rowId: threadA,
    plaintext: { historyCompactionSummary: summary },
  },
  {
    model: "Message",
    table: "messages",
    fields: ["blocks", "toolHistory"],
    owner: threadA,
    sql: `SELECT id, "threadId", blocks, "toolHistory", "searchTokens" FROM messages WHERE id = $1`,
    rowId: `${id("m1")}`,
    plaintext: { blocks, toolHistory },
  },
  {
    model: "Event",
    table: "events",
    fields: ["payload"],
    owner: threadA,
    sql: `SELECT id, "spaceId", "threadId", payload FROM events WHERE id = $1`,
    rowId: id("ev"),
    plaintext: { payload: eventPayload },
  },
  {
    model: "MemoryDocument",
    table: "memory_documents",
    fields: ["content"],
    owner: user.id,
    sql: `SELECT id, "spaceId", "userId", content FROM memory_documents WHERE id = $1`,
    rowId: docA.id,
    plaintext: { content: contentA },
  },
  {
    model: "MemoryRevision",
    table: "memory_revisions",
    fields: ["content"],
    owner: docA.id,
    sql: `SELECT id, "documentId", content FROM memory_revisions WHERE id = $1`,
    rowId: id("rev"),
    plaintext: { content: revisionContent },
  },
  {
    model: "BotEmailMessage",
    table: "bot_email_messages",
    fields: ["fromAddress", "fromName", "subject", "text"],
    owner: bot.id,
    sql: `SELECT id, "spaceId", "botId", "fromAddress", "fromName", subject, text, "searchTokens"
          FROM bot_email_messages WHERE id = $1`,
    rowId: id("mail"),
    plaintext: email,
  },
];

function locationOf(entry: (typeof modelRows)[number], column: string) {
  return { table: entry.table, column, rowId: entry.rowId, owner: entry.owner };
}

/** Prisma returns JsonValue; give the Go driver plain JSON. */
function plain(value: unknown) {
  return JSON.parse(JSON.stringify(value));
}

// ------------------------------------------------- TS seals -> Go opens
for (const entry of modelRows) {
  const rawRows = await system.$queryRawUnsafe<any[]>(entry.sql, entry.rowId);
  assert.equal(rawRows.length, 1, `${entry.model}: seed row missing`);

  // Go opens the stored rows; TypeScript's own reader must produce exactly the
  // same values from the same bytes.
  const tsOpened = plain(rawRows);
  await encryption.openRows(entry.model, tsOpened);
  const goOpened = await go({ op: "open-model", model: entry.model, rows: plain(rawRows) });
  await check(`${entry.model}: Go opens TypeScript ciphertext`, () => {
    assert.deepStrictEqual(goOpened.rows, tsOpened);
  });
  for (const column of entry.fields) {
    if (column === "blocks" || column === "payload") {
      const items = Array.isArray(rawRows[0][column]) ? rawRows[0][column] : [rawRows[0][column]];
      const originals = Array.isArray(entry.plaintext[column as keyof typeof entry.plaintext])
        ? (entry.plaintext[column as keyof typeof entry.plaintext] as unknown[])
        : [entry.plaintext[column as keyof typeof entry.plaintext]];
      for (const [index, item] of items.entries()) {
        if (typeof item?.$sealed !== "string") continue;
        const keyId = item.$sealed.slice("rkz1:".length, item.$sealed.indexOf(":", 5));
        const opened = await go({
          op: "decrypt-text",
          keyId,
          keySpaceId: rawRows[0].spaceId,
          ...locationOf(entry, column),
          value: item.$sealed,
        });
        await check(`${entry.model}.${column}[${index}] opens byte-identically`, () => {
          assert.equal(opened.plaintext, JSON.stringify(originals[index]));
        });
      }
      continue;
    }
    const value = rawRows[0][column];
    const keyId = value.slice("rkz1:".length, value.indexOf(":", 5));
    const opened = await go({
      op: "decrypt-text",
      keyId,
      keySpaceId: rawRows[0].spaceId,
      ...locationOf(entry, column),
      value,
    });
    await check(`${entry.model}.${column} opens byte-identically`, () => {
      assert.equal(opened.plaintext, entry.plaintext[column as keyof typeof entry.plaintext]);
    });
  }
}

// ------------------------------------------------- Go seals -> TS opens
const goRows = [
  {
    model: "Thread",
    row: { id: id("th-go"), spaceId: spaceA, userId: user.id, historyCompactionSummary: "Go summary 😀 <&>" },
    fields: ["historyCompactionSummary"],
  },
  {
    model: "Message",
    row: { id: id("m-go"), threadId: threadA, blocks, toolHistory: toolHistory },
    fields: ["blocks", "toolHistory"],
  },
  {
    model: "Event",
    row: { id: id("ev-go"), spaceId: spaceA, threadId: threadA, botId: bot.id, payload: eventPayload },
    fields: ["payload"],
  },
  {
    model: "MemoryDocument",
    row: { id: id("doc-go"), spaceId: spaceA, userId: user.id, content: "Go content İ 😀" },
    fields: ["content"],
  },
  {
    model: "MemoryRevision",
    row: { id: id("rev-go"), documentId: docA.id, content: "Go revision <&>" },
    fields: ["content"],
  },
  {
    model: "BotEmailMessage",
    row: { id: id("mail-go"), spaceId: spaceA, botId: bot.id, ...email },
    fields: ["fromAddress", "fromName", "subject", "text"],
  },
];
for (const entry of goRows) {
  const sealed = await go({ op: "seal-model", model: entry.model, rows: [plain(entry.row)] });
  const sealedRow = sealed.rows[0];
  const toOpen: Record<string, unknown> = { ...plain(entry.row) };
  for (const field of entry.fields) toOpen[field] = sealedRow[field];
  if (sealedRow.searchTokens) toOpen.searchTokens = sealedRow.searchTokens;
  await encryption.openRows(entry.model, [toOpen]);
  await check(`${entry.model}: TypeScript opens Go ciphertext`, () => {
    for (const field of entry.fields) {
      const original = entry.row[field as keyof typeof entry.row];
      if (field === "blocks" || field === "payload") assert.deepStrictEqual(toOpen[field], plain(original));
      else assert.equal(toOpen[field], original);
    }
  });
  if (entry.model === "Message" || entry.model === "BotEmailMessage") {
    const tsSealed = await encryption.sealRow(entry.model, plain(entry.row));
    await check(`${entry.model}: blind-index tokens match TypeScript`, () => {
      assert.deepStrictEqual(sealedRow.searchTokens, tsSealed.searchTokens);
      assert(sealedRow.searchTokens.length > 0, "tokens expected");
    });
  }
}

// ------------------------------------------------- failure cases
const docARaw = (await system.$queryRawUnsafe<any[]>(
  `SELECT id, "spaceId", "userId", content FROM memory_documents WHERE id = $1`,
  docA.id,
))[0];
const docBRaw = (await system.$queryRawUnsafe<any[]>(
  `SELECT id, "spaceId", "userId", content FROM memory_documents WHERE id = $1`,
  docB.id,
))[0];
const ciphertextA = docARaw.content as string;
const keyA = ciphertextA.slice(5, ciphertextA.indexOf(":", 5));
const keyB = (docBRaw.content as string).slice(5, (docBRaw.content as string).indexOf(":", 5));
const contentLocation = { table: "memory_documents", column: "content", rowId: docA.id, owner: user.id };

type FailureCase = {
  name: string;
  keyId: string;
  keySpaceId?: string;
  location?: Record<string, string>;
  value: string;
};
/**
 * Flips one bit of ciphertext, never the tag, and re-encodes canonically.
 * Changing the last base64url character alone can be a no-op: for a body whose
 * length mod 3 is 2, the final character carries only four significant bits, so
 * swapping A for B can leave the decoded bytes identical and both sides would
 * still decrypt. Decoding, flipping a whole ciphertext byte and re-encoding
 * always tampers. A body with no ciphertext byte (empty plaintext) flips an IV
 * byte, which GCM authentication still rejects.
 */
function tamperedBody(ciphertext: string): string {
  const separator = ciphertext.indexOf(":", "rkz1:".length);
  const body = Buffer.from(ciphertext.slice(separator + 1), "base64url");
  const at = Math.max(0, body.length - 16 - 1);
  body[at] ^= 0x01;
  return `${ciphertext.slice(0, separator + 1)}${body.toString("base64url")}`;
}

const failureCases: FailureCase[] = [
  { name: "wrong owner", keyId: keyA, location: { ...contentLocation, owner: `${user.id}-other` }, value: ciphertextA },
  { name: "wrong column", keyId: keyA, location: { ...contentLocation, column: "content2" }, value: ciphertextA },
  { name: "wrong row", keyId: keyA, location: { ...contentLocation, rowId: `${docA.id}-other` }, value: ciphertextA },
  { name: "wrong space", keyId: keyA, keySpaceId: spaceB, value: ciphertextA },
  { name: "another key id", keyId: keyB, value: ciphertextA },
  { name: "tampered body", keyId: keyA, value: tamperedBody(ciphertextA) },
  { name: "truncated body", keyId: keyA, value: `rkz1:${keyA}:AAAA` },
];
for (const failure of failureCases) {
  const location = failure.location ?? contentLocation;
  const key = await contentKeys.byId(failure.keyId);
  let tsError = "";
  try {
    decryptText(failure.keySpaceId ? { ...key, spaceId: failure.keySpaceId } : key, location, failure.value);
  } catch (error) {
    tsError = (error as Error).message;
  }
  const goMessage = await goError({
    op: "decrypt-text",
    keyId: failure.keyId,
    keySpaceId: failure.keySpaceId,
    ...location,
    value: failure.value,
  });
  await check(`failure: ${failure.name} fails identically`, () => {
    assert(tsError, "TypeScript must reject the value");
    assert.equal(goMessage, tsError);
  });
}

// A ciphertext moved to another Space must fail the same way in both readers.
{
  const spliced = { ...plain(docBRaw), content: ciphertextA };
  let tsError = "";
  try {
    await encryption.openRows("MemoryDocument", [spliced]);
  } catch (error) {
    tsError = (error as Error).message;
  }
  const goMessage = await goError({ op: "open-model", model: "MemoryDocument", rows: [{ ...plain(docBRaw), content: ciphertextA }] });
  await check("failure: ciphertext in another Space fails identically", () => {
    assert.equal(tsError, "Encrypted content belongs to another space");
    assert.equal(goMessage, tsError);
  });
}

// ------------------------------------------------- Node base64 leniency
{
  const prefix = ciphertextA.slice(0, ciphertextA.indexOf(":", "rkz1:".length) + 1);
  const body = ciphertextA.slice(prefix.length);
  const standard = body.replace(/-/g, "+").replace(/_/g, "/");
  const variants: Array<[string, string]> = [
    ["padded", `${prefix}${body}==`],
    ["junk characters", `${prefix}${body.slice(0, 10)}!!${body.slice(10)}`],
    ["standard alphabet", `${prefix}${standard}`],
    // Buffer.from stops at the first "=", so the repeated body is ignored.
    ["padding ends the input", `${prefix}${body}=${body}`],
  ];
  const key = await contentKeys.byId(keyA);
  for (const [name, value] of variants) {
    const tsOpened = decryptText(key, contentLocation, value);
    const goOpened = await go({
      op: "decrypt-text",
      keyId: keyA,
      ...contentLocation,
      value,
    });
    await check(`body form: ${name} opens identically`, () => {
      assert.equal(tsOpened, contentA);
      assert.equal(goOpened.plaintext, tsOpened);
    });
  }
}

// ------------------------------------------------- key lifecycle
const keyLocation = {
  table: "threads",
  column: "historyCompactionSummary",
  rowId: id("th-keys"),
  owner: user.id,
};
{
  const created = await go({ op: "current-key", spaceId: spaceC });
  await check("key: Go creates a space key TypeScript unwraps", async () => {
    const tsKey = await contentKeys.byId(created.keyId);
    assert.equal(tsKey.id, created.keyId);
    assert.equal(tsKey.spaceId, spaceC);
    assert.equal(tsKey.version, created.version);
    const sealedByTs = encryptText(tsKey, keyLocation, "TS sealed under a Go-created key İ 😀");
    const goOpened = await go({
      op: "decrypt-text",
      keyId: created.keyId,
      ...keyLocation,
      value: sealedByTs,
    });
    assert.equal(goOpened.plaintext, "TS sealed under a Go-created key İ 😀");
    const sealedByGo = await go({
      op: "encrypt-text",
      keyId: created.keyId,
      ...keyLocation,
      plaintext: "Go sealed under its own key",
    });
    assert.equal(decryptText(tsKey, keyLocation, sealedByGo.ciphertext), "Go sealed under its own key");
  });
}

{
  const rotated = await contentKeys.rotate(spaceC);
  await check("key: Go uses a TypeScript rotation after its key TTL", async () => {
    // The driver's ring uses GO_PROOF_KEY_TTL_MS=1000 (set when it is spawned).
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const current = await go({ op: "current-key", spaceId: spaceC });
    assert.equal(current.keyId, rotated.id);
    assert.equal(current.version, rotated.version);
    assert.equal(rotated.version, 2);
    const sealedByGo = await go({
      op: "encrypt-text",
      keyId: current.keyId,
      ...keyLocation,
      plaintext: "rotated key seal",
    });
    const tsKey = await contentKeys.byId(current.keyId);
    assert.equal(decryptText(tsKey, keyLocation, sealedByGo.ciphertext), "rotated key seal");
  });
}

{
  const userVault = await contentKeys.current(`user:${user.id}`);
  const goUserVault = await go({ op: "current-key", spaceId: `user:${user.id}` });
  await check("key: Go unwraps the TypeScript user vault key", async () => {
    assert.equal(goUserVault.keyId, userVault.id);
    assert.equal(goUserVault.version, userVault.version);
    const sealedByGo = await go({
      op: "encrypt-text",
      keyId: goUserVault.keyId,
      ...keyLocation,
      plaintext: "user vault seal",
    });
    assert.equal(decryptText(userVault, keyLocation, sealedByGo.ciphertext), "user vault seal");
  });

  const spaceVault = await contentKeys.current(`vault:${spaceC}`);
  const goSpaceVault = await go({ op: "current-key", spaceId: `vault:${spaceC}` });
  await check("key: Go unwraps the TypeScript space vault key", async () => {
    assert.equal(goSpaceVault.keyId, spaceVault.id);
    assert.equal(goSpaceVault.version, spaceVault.version);
    const sealedByTs = encryptText(spaceVault, keyLocation, "space vault seal");
    const goOpened = await go({
      op: "decrypt-text",
      keyId: spaceVault.id,
      ...keyLocation,
      value: sealedByTs,
    });
    assert.equal(goOpened.plaintext, "space vault seal");
  });
}

// ------------------------------------------------- sanitization parity
{
  const payloads = [
    {
      text: "nul\u0000inside",
      nested: { list: ["a\ud800b", 1, true, null] },
    },
    // Distinct keys that collapse to the same sanitized string; the insertion
    // order here matches Go's sorted order, so the suffix assignment agrees.
    { "\u0000": "first", "\uFFFD": "second" },
  ];
  for (const [index, payload] of payloads.entries()) {
    const tsSanitized = plain(sanitizeJsonValue(payload));
    const goSanitized = (await go({ op: "sanitize", payload })).value;
    await check(`sanitize: payload ${index} matches TypeScript`, () => {
      assert.deepStrictEqual(goSanitized, tsSanitized);
      assert(!JSON.stringify(goSanitized).includes("\\u0000"));
    });
  }
}

// ------------------------------------------------- event append + notify
const eventThread = id("th-events");
await system.thread.create({ data: { id: eventThread, spaceId: spaceA, userId: user.id, botId: bot2.id } });
const listener = await pool.connect();
const captured: string[] = [];
listener.on("notification", (notification) => {
  if (notification.channel === "rakazo_events" && notification.payload) captured.push(notification.payload);
});
await listener.query("LISTEN rakazo_events");
const fanout = new PostgresRealtimeFanout({
  connectionString: DATABASE_URL,
  publisher: { query: (sql: string, values: unknown[]) => pool.query(sql, values as any[]) },
});

async function tsAppend(n: number) {
  const payload = { delta: `ts-${n}`, streaming: true };
  const event = await appendEvent(
    system as any,
    { spaceId: spaceA, threadId: eventThread, botId: bot2.id, type: "thread.progress", payload },
    fanout as any,
  );
  return { producer: "ts" as const, seq: event.seq, payload, id: event.id };
}

async function tsBurst(count: number) {
  return Promise.all(Array.from({ length: count }, (_, index) => tsAppend(index)));
}

const appended: Array<{ producer: "ts" | "go"; seq: number; payload: any; id: string }> = [];
for (let n = 0; n < 3; n += 1) {
  appended.push(await tsAppend(n));
  const event = await go({
    op: "append",
    spaceId: spaceA,
    threadId: eventThread,
    botId: bot2.id,
    type: "thread.progress",
    payload: { delta: `go-${n}`, streaming: true },
    notify: true,
  });
  appended.push({ producer: "go", seq: event.event.seq, payload: event.event.payload, id: event.event.id });
}
{
  const [tsEvents, goEvents] = await Promise.all([
    tsBurst(3),
    go({
      op: "append-burst",
      count: 3,
      spaceId: spaceA,
      threadId: eventThread,
      botId: bot2.id,
      type: "thread.progress",
      payload: { delta: "burst", streaming: true },
      notify: true,
    }),
  ]);
  appended.push(...tsEvents);
  appended.push(
    ...goEvents.events.map((event: any) => ({
      producer: "go" as const,
      seq: event.seq,
      payload: event.payload,
      id: event.id,
    })),
  );
}
const expectedEvents = appended.length;

const waitUntil = async (predicate: () => boolean, what: string) => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
await waitUntil(() => captured.length >= expectedEvents, "realtime notifications");

await check("event seqs are gap-free and distinct", async () => {
  const rows = await system.event.findMany({ where: { threadId: eventThread }, orderBy: { seq: "asc" } });
  assert.equal(rows.length, expectedEvents);
  assert.deepStrictEqual(
    rows.map((row: any) => row.seq),
    Array.from({ length: expectedEvents }, (_, index) => index),
  );
  const thread = await system.thread.findUniqueOrThrow({ where: { id: eventThread } });
  assert.equal(thread.nextEventSeq, expectedEvents);
  for (const event of appended) {
    const row = rows.find((candidate: any) => candidate.id === event.id);
    assert(row, `event ${event.id} missing`);
    assert.deepStrictEqual(row.payload, event.payload);
  }
});

await check("stored payloads are sealed", async () => {
  const [raw] = await system.$queryRawUnsafe<any[]>(
    `SELECT payload::text AS payload FROM events WHERE id = $1`,
    appended[0].id,
  );
  assert(!raw.payload.includes("ts-0"), "payload leaked plaintext");
});

await check("notify envelopes are identical and complete", () => {
  assert.equal(captured.length, expectedEvents);
  const cursorByEnvelope = new Map<string, number>();
  for (const raw of captured) {
    const envelope = JSON.parse(raw);
    assert.deepStrictEqual(Object.keys(envelope), ["topic", "payload"]);
    assert.equal(envelope.topic, `thread:${eventThread}`);
    const payload = JSON.parse(envelope.payload);
    assert.deepStrictEqual(Object.keys(payload), ["cursor"]);
    cursorByEnvelope.set(raw, payload.cursor);
    // Byte-for-byte the same envelope both implementations produce.
    const expected = JSON.stringify({
      topic: `thread:${eventThread}`,
      payload: JSON.stringify({ cursor: payload.cursor }),
    });
    assert.equal(raw, expected);
  }
  assert.deepStrictEqual(
    [...cursorByEnvelope.values()].sort((a, b) => a - b),
    Array.from({ length: expectedEvents }, (_, index) => index),
  );
  const producedByTs = appended.filter((event) => event.producer === "ts").map((event) => event.seq);
  const producedByGo = appended.filter((event) => event.producer === "go").map((event) => event.seq);
  for (const cursor of [...producedByTs, ...producedByGo]) {
    const raw = [...cursorByEnvelope.entries()].find(([, value]) => value === cursor)![0];
    const expected = JSON.stringify({ topic: `thread:${eventThread}`, payload: JSON.stringify({ cursor }) });
    assert.equal(raw, expected);
  }
});

// First response: both sides record it once, at the event's time, with the
// same timing fields notifyCommittedEvent would log.
const firstRuns: Array<{ producer: "ts" | "go"; runId: string; event: any }> = [];
for (const producer of ["ts", "go"] as const) {
  const task = await system.task.create({
    data: {
      id: id(`task-${producer}`),
      spaceId: spaceA,
      botId: bot2.id,
      threadId: eventThread,
      userId: user.id,
      prompt: "proof reply",
      status: "running",
    },
  });
  const run = await system.run.create({
    data: {
      id: id(`run-${producer}`),
      spaceId: spaceA,
      botId: bot2.id,
      threadId: eventThread,
      taskId: task.id,
      userId: user.id,
      status: "running",
      trigger: "user",
      startedAt: new Date(),
      leaseOwner: "proof",
      leaseFence: 1,
    },
  });
  const payload = { messageId: id(`msg-${producer}`), role: "bot", blocks: [{ kind: "text", text: `hello from ${producer}` }] };
  if (producer === "ts") {
    const event = await appendEvent(
      system as any,
      { spaceId: spaceA, threadId: eventThread, botId: bot2.id, type: "thread.message.created", payload, runId: run.id },
      fanout as any,
    );
    firstRuns.push({ producer, runId: run.id, event });
  } else {
    const response = await go({
      op: "append",
      spaceId: spaceA,
      threadId: eventThread,
      botId: bot2.id,
      type: "thread.message.created",
      payload,
      runId: run.id,
      notify: true,
    });
    firstRuns.push({ producer, runId: run.id, event: response.event });
  }
}

await check("first response is recorded once, at the event time", async () => {
  for (const entry of firstRuns) {
    const stored = await system.run.findUniqueOrThrow({ where: { id: entry.runId } });
    assert(stored.firstResponseAt, `${entry.producer} did not record a first response`);
    assert.equal(stored.firstResponseAt.getTime(), new Date(entry.event.createdAt).getTime());
  }
  const tsTiming = await readRunTimingFields(system as any, firstRuns[0].runId);
  const goTiming = (await go({ op: "timing", runId: firstRuns[1].runId })).timing;
  const tsTimingGoRun = await readRunTimingFields(system as any, firstRuns[1].runId);
  assert.deepStrictEqual(goTiming, tsTimingGoRun);
  assert.equal(tsTiming["run.trigger"], "user");
});

// Leave no listener behind; the fixture is disposable but the connections are not.
listener.release();
await pool.end();
child.stdin!.end();
console.log(`PASS ${checks} checks`);
