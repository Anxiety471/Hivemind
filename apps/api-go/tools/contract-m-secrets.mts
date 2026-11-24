/**
 * Lane M cases: the secret-store writes — vault.put/remove/reveal, botSecrets.put/remove and
 * agentSecrets.put/remove.
 *
 * Seeded vault rows are sealed the way the shipped code seals them: `rkz1:` under the vault's own
 * content key when the case gives it one, and the legacy `v2:` record form otherwise. laneMState
 * opens every row with the TypeScript store, so a row Go wrote must open here (the AAD names the
 * record, its person and its Space) and a row seeded here must open in Go (every reveal/relabel
 * case proves that direction).
 *
 * The audit metadata of these procedures carries a user-typed name. The TypeScript redactor may
 * rewrite one, so Go declines those requests (local.ErrDecline) and the gateway answers them from
 * TypeScript; `declines: true` proves the hand-off and the database comparison proves the accepted
 * names are byte-identical in the audit row (a redacted name would differ). The gate-* cases are
 * that differential corpus.
 */
import assert from "node:assert/strict";
import { EncryptedSecretStore } from "../../../packages/adapters/src/secrets/secrets.js";
import { openVaultValue } from "../../../packages/adapters/src/secrets/vault/vault-values.js";
import { contentEncryptionOf, encryptText } from "../../../packages/db/src/index.js";
import type { Case, Seeded } from "./contract.mts";
import { CONTRACT_ENCRYPTION_KEY } from "./contract-key.mts";

type System = any;

const OLD = new Date(Date.UTC(2021, 3, 2));
const store = new EncryptedSecretStore(CONTRACT_ENCRYPTION_KEY);
const sealContext = {
  operationId: "seed",
  traceId: "seed",
  userId: "seed",
  spaceId: "seed",
  signal: new AbortController().signal,
} as never;

/** The legacy record form: sealed by the credential store, bound to its record id. */
async function v2(recordId: string, plaintext: string): Promise<string> {
  return (await store.put(plaintext, sealContext, { recordId })).ciphertext;
}

type VaultSeed = {
  /** Item name. */
  name?: string;
  origin?: string;
  auth?: Record<string, unknown>;
  plaintext: string;
  /** Index into the case's Spaces, or null for the account vault. */
  space?: 0 | 1 | 2 | null;
  title?: string;
  note?: string;
  policy?: string;
  alsoOn?: string[];
  allBots?: boolean;
  botIds?: string[];
  /** Seal with the legacy record form instead of the vault's content key. */
  legacy?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  rowId?: string;
};

export function laneMSecretCases(system: System): Case[] {
  const vaultScope = (seeded: Seeded, space: 0 | 1 | 2 | null | undefined) =>
    space === null || space === undefined ? `user:${seeded.userId}` : `vault:${seeded.spaces[space]}`;
  const addVault = async (seeded: Seeded, seed: VaultSeed) => {
    const id =
      seed.rowId ??
      `${seeded.userId}-v-${seed.space === null || seed.space === undefined ? "acct" : `s${seed.space}`}-${seed.name ?? "item"}`;
    const spaceId = seed.space === null || seed.space === undefined ? null : seeded.spaces[seed.space];
    let ciphertext: string;
    if (seed.legacy) {
      ciphertext = await v2(id, seed.plaintext);
    } else {
      const scope = vaultScope(seeded, seed.space);
      const ring = contentEncryptionOf(system)!.ring;
      // reset() does not forget a scope's cached key, and a case may have recreated the row's key.
      ring.forget(scope);
      const key = await ring.current(scope);
      ciphertext = encryptText(
        key,
        { table: "vault_credentials", column: "ciphertext", rowId: id, owner: seeded.userId },
        seed.plaintext,
      );
    }
    const row = await system.vaultCredential.create({
      data: {
        id,
        userId: seeded.userId,
        spaceId,
        name: seed.name ?? "item",
        origin: seed.origin ?? "https://example.test",
        auth: seed.auth ?? { type: "bearer" },
        title: seed.title ?? "",
        note: seed.note ?? "",
        policy: seed.policy ?? "allow",
        alsoOn: seed.alsoOn ?? [],
        ciphertext,
        createdAt: seed.createdAt ?? OLD,
        updatedAt: seed.updatedAt ?? OLD,
      },
    });
    if (seed.allBots !== undefined || seed.botIds !== undefined) {
      await system.vaultCredentialLimit.create({
        data: {
          id: `${id}-limit`,
          credentialId: id,
          userId: seeded.userId,
          spaceId: seeded.spaces[spaceOf(seed)],
          createdAt: OLD,
        },
      });
    }
    for (const [index, placeholder] of (seed.allBots === true ? [] : (seed.botIds ?? [])).entries()) {
      // The runner rewrites `__name__` in a request body but not in this seed, so rows must carry
      // the bot id the request will resolve to.
      const botId = /^__([a-z0-9]+)__$/.exec(placeholder)?.[1] ?? null;
      await system.vaultCredentialBot.create({
        data: {
          id: `${id}-bot-${index}`,
          credentialId: id,
          botId: botId === null ? placeholder : `${seeded.userId}-${botId}`,
          userId: seeded.userId,
          spaceId: seeded.spaces[spaceOf(seed)],
          createdAt: OLD,
        },
      });
    }
    return row;
  };
  const spaceOf = (seed: VaultSeed) => (seed.space ?? 0) as 0 | 1 | 2;
  const addBot = (seeded: Seeded, id: string, extra: Record<string, unknown> = {}) =>
    system.bot.create({
      data: {
        id: `${seeded.userId}-${id}`,
        spaceId: seeded.spaces[0],
        userId: seeded.userId,
        name: id,
        color: "blue",
        createdAt: OLD,
        updatedAt: OLD,
        ...extra,
      },
    });
  /** The vault this Space uses becomes its own. */
  const addOverride = (seeded: Seeded, space: 0 | 1 | 2 = 0) =>
    system.spaceSettingOverride.create({
      data: {
        spaceId: seeded.spaces[space],
        userId: seeded.userId,
        setting: "credentials",
        createdAt: OLD,
      },
    });
  /** The person is only a guest of their organization, so a Space vault event must not name the item. */
  const makeGuest = (seeded: Seeded) =>
    system.member.update({ where: { id: `${seeded.orgId}-m` }, data: { role: "guest" } });
  /** The Space's own role is not owner, so the owner-only procedures refuse. */
  const notSpaceOwner = (seeded: Seeded, space: 0 | 1 | 2 = 0) =>
    system.spaceMember.update({
      where: { id: `${seeded.spaces[space]}-m` },
      data: { role: "guest" },
    });
  const confirm = (seeded: Seeded) =>
    system.verification.create({
      data: {
        id: `${seeded.userId}-confirmation`,
        identifier: `identity-confirmed-${seeded.userId}-session`,
        value: seeded.userId,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });
  const login = (fields: unknown[], otp?: string) =>
    JSON.stringify(otp === undefined ? { fields } : { fields, otp });
  const command = (seeded: Seeded, name: string, value = "value") =>
    addVault(seeded, { name, auth: { type: "command" }, plaintext: value, origin: "" });
  const validKey = "JBSWY3DPEHPK3PXP";

  const put = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name,
    procedure: "vault.put",
    input,
    secretAnnouncements: true,
    ...extra,
  });
  const remove = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name,
    procedure: "vault.remove",
    input,
    secretAnnouncements: true,
    ...extra,
  });
  const reveal = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name,
    procedure: "vault.reveal",
    input,
    ...extra,
  });
  const botPut = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name,
    procedure: "botSecrets.put",
    input,
    secretAnnouncements: true,
    ...extra,
  });
  const botRemove = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name,
    procedure: "botSecrets.remove",
    input,
    secretAnnouncements: true,
    ...extra,
  });
  const agentPut = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name,
    procedure: "agentSecrets.put",
    input,
    secretAnnouncements: true,
    ...extra,
  });
  const agentRemove = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name,
    procedure: "agentSecrets.remove",
    input,
    secretAnnouncements: true,
    ...extra,
  });
  const destination = (extra: Record<string, unknown> = {}) => ({
    name: "api",
    origin: "https://example.test",
    auth: { type: "bearer" },
    ...extra,
  });

  return [
    // ---- vault.put: the six auth kinds ---------------------------------------------------
    put(
      "vput-bearer-create",
      { destination: destination({ name: undefined }), value: "token-value" },
      { declines: false, after: [{ procedure: "vault.list", input: {} }] },
    ),
    put("vput-bearer-named", { destination: destination(), value: "token-value" }),
    put("vput-header", {
      destination: destination({ auth: { type: "header", name: "X-Api-Key" } }),
      value: "header-value",
    }),
    put("vput-basic", {
      destination: destination({ auth: { type: "basic", username: "alice" } }),
      value: "basic-value",
    }),
    put(
      "vput-login",
      {
        destination: destination({
          name: "login-example",
          origin: "https://login.example.test/signin?next=%2Fapp",
          auth: { type: "login" },
        }),
        value: login(
          [
            { label: "  User  ", value: "  alice  ", hidden: false },
            { label: "Password", value: "p@ss word", hidden: true },
            { label: "Account", value: "42", hidden: false },
          ],
          validKey,
        ),
        title: "  My login  ",
        note: "For travel",
        policy: "ask",
        allBots: true,
        alsoOn: ["https://other.example.test", "https://third.example.test"],
      },
      { after: [{ procedure: "vault.list", input: { scope: "account" } }] },
    ),
    put("vput-login-legacy", {
      destination: destination({ name: "legacy-login", origin: "https://legacy.example.test", auth: { type: "login" } }),
      value: JSON.stringify({ username: "  old user  ", password: "old-password" }),
    }),
    put("vput-login-otp-empty", {
      destination: destination({ name: "otp-empty", origin: "https://otp.example.test", auth: { type: "login" } }),
      value: login([{ label: "User", value: "u", hidden: false }], ""),
    }),
    put("vput-login-otp-invalid", {
      destination: destination({ name: "otp-bad", origin: "https://otp.example.test", auth: { type: "login" } }),
      value: login([{ label: "User", value: "u", hidden: false }], "123456"),
    }),
    put("vput-login-duplicate-label", {
      destination: destination({ name: "dup-label", origin: "https://dup.example.test", auth: { type: "login" } }),
      value: login([
        { label: "User", value: "a", hidden: false },
        { label: " user ", value: "b", hidden: false },
      ]),
    }),
    put("vput-login-hidden-empty", {
      destination: destination({ name: "hidden-empty", origin: "https://hidden.example.test", auth: { type: "login" } }),
      value: login([{ label: "User", value: "", hidden: false }]),
    }),
    put("vput-login-not-json", {
      destination: destination({ name: "not-json", origin: "https://json.example.test", auth: { type: "login" } }),
      value: "plain",
    }),
    put("vput-card", {
      destination: destination({
        name: "card",
        origin: "",
        auth: { type: "card" },
      }),
      value: JSON.stringify({
        number: "4242 4242 4242 4242",
        expMonth: 4,
        expYear: 2031,
        cvc: "123",
        name: "  Alice  ",
        billing: "berlin-card",
      }),
      title: "Travel card",
      botIds: [],
    }),
    put("vput-card-luhn", {
      destination: destination({ name: "card-bad", origin: "", auth: { type: "card" } }),
      value: JSON.stringify({ number: "4242 4242 4242 4241", expMonth: 4, expYear: 2031 }),
    }),
    put("vput-card-extra-key", {
      destination: destination({ name: "card-extra", origin: "", auth: { type: "card" } }),
      value: JSON.stringify({ number: "4242424242424242", expMonth: 4, expYear: 2031, cvv: "123" }),
    }),
    put("vput-card-month", {
      destination: destination({ name: "card-month", origin: "", auth: { type: "card" } }),
      value: JSON.stringify({ number: "4242424242424242", expMonth: 13, expYear: 2031 }),
    }),
    put("vput-contact", {
      destination: destination({ name: "contact", origin: "", auth: { type: "contact" } }),
      value: JSON.stringify({
        name: "  Alice Example  ",
        line1: " Main 1 ",
        line2: "",
        city: "Berlin",
        region: "BE",
        postalCode: "10115",
        country: "DE",
        phone: " +1 555 0100 ",
        email: "alice@example.test",
      }),
      title: "My contact",
    }),
    put("vput-contact-empty", {
      destination: destination({ name: "contact-empty", origin: "", auth: { type: "contact" } }),
      value: JSON.stringify({ name: "", email: "  ", city: "" }),
    }),
    put("vput-command", {
      destination: destination({ name: "deploy-key", origin: "", auth: { type: "command" } }),
      value: "s3cret-value",
    }),
    put("vput-command-with-origin", {
      destination: destination({ name: "deploy-key", origin: "https://example.test", auth: { type: "command" } }),
      value: "s3cret-value",
    }),
    put("vput-command-nul", {
      destination: destination({ name: "deploy-key", origin: "", auth: { type: "command" } }),
      value: "bad\u0000value",
    }),
    put("vput-command-surrogate", {
      destination: destination({ name: "deploy-key", origin: "", auth: { type: "command" } }),
      value: "bad\ud800value",
    }),
    put("vput-page-url", {
      destination: destination({ name: "page", origin: "https://www.example.test:8443/path?a=1#x" }),
      value: "token-value",
    }),
    put("vput-page-url-userinfo", {
      destination: destination({ name: "page", origin: "https://user:pass@example.test/path" }),
      value: "token-value",
    }),
    put("vput-bearer-trimmed-header", {
      destination: destination({ name: "trimmed", origin: "https://example.test", auth: { type: "header", name: "Authorization" } }),
      value: " value",
    }),

    // ---- vault.put: the vault it lands in ------------------------------------------------
    put(
      "vput-space-no-override",
      { scope: "space", destination: destination({ name: "space-item" }), value: "token-value" },
      { declines: false },
    ),
    put(
      "vput-space-override",
      { scope: "space", destination: destination({ name: "space-item" }), value: "token-value" },
      { seed: (seeded) => addOverride(seeded), after: [{ procedure: "vault.list", input: {} }] },
    ),
    put(
      "vput-space-key",
      { scope: "space", destination: destination({ name: "space-item" }), value: "token-value" },
      {
        seed: async (seeded) => {
          await addOverride(seeded);
          // A Space vault's own content key: the write must seal under it, naming the Space.
          contentEncryptionOf(system)!.ring.forget(`vault:${seeded.spaces[0]}`);
          await contentEncryptionOf(system)!.ring.current(`vault:${seeded.spaces[0]}`);
        },
      },
    ),
    put(
      "vput-account-with-override",
      { scope: "account", destination: destination({ name: "account-item" }), value: "token-value" },
      { seed: (seeded) => addOverride(seeded) },
    ),
    put(
      "vput-default-with-override",
      { destination: destination({ name: "default-item" }), value: "token-value" },
      { seed: (seeded) => addOverride(seeded) },
    ),
    put("vput-user-key", { destination: destination({ name: "user-key" }), value: "token-value" }, {
      seed: async (seeded) => {
        contentEncryptionOf(system)!.ring.forget(`user:${seeded.userId}`);
        await contentEncryptionOf(system)!.ring.current(`user:${seeded.userId}`);
      },
    }),

    // ---- vault.put: labels, overwrite and relabel ---------------------------------------
    put(
      "vput-relabel-title-note",
      { destination: destination({ name: "saved" }), title: "  New title ", note: "New note" },
      { seed: (seeded) => addVault(seeded, { name: "saved", plaintext: "token-value" }) },
    ),
    put(
      "vput-relabel-policy",
      { destination: destination({ name: "saved" }), policy: "off" },
      { seed: (seeded) => addVault(seeded, { name: "saved", plaintext: "token-value" }) },
    ),
    put(
      "vput-relabel-alsoOn",
      {
        destination: destination({ name: "saved", origin: "https://login.example.test", auth: { type: "login" } }),
        alsoOn: ["https://one.example.test", "https://two.example.test"],
      },
      {
        seed: (seeded) =>
          addVault(seeded, {
            name: "saved",
            origin: "https://login.example.test",
            auth: { type: "login" },
            plaintext: login([{ label: "User", value: "u" }]),
            title: "Kept",
            policy: "ask",
            alsoOn: ["https://old.example.test"],
          }),
      },
    ),
    put(
      "vput-relabel-missing",
      { destination: destination({ name: "absent" }), title: "New title" },
      { declines: false },
    ),
    put("vput-relabel-no-name", { destination: destination({ name: undefined }), title: "New title" }),
    put(
      "vput-relabel-guest",
      { destination: destination({ name: "saved" }), title: "New title" },
      {
        seed: async (seeded) => {
          await addVault(seeded, { name: "saved", plaintext: "token-value" });
          await makeGuest(seeded);
        },
      },
    ),
    put(
      "vput-overwrite-keeps-otp",
      {
        destination: destination({ name: "saved", origin: "https://login.example.test", auth: { type: "login" } }),
        value: login([{ label: "User", value: "u" }, { label: "Password", value: "p", hidden: true }]),
      },
      {
        seed: (seeded) =>
          addVault(seeded, {
            name: "saved",
            origin: "https://login.example.test",
            auth: { type: "login" },
            plaintext: login([{ label: "User", value: "u" }], validKey),
          }),
      },
    ),
    put(
      "vput-overwrite-clears-otp",
      {
        destination: destination({ name: "saved", origin: "https://login.example.test", auth: { type: "login" } }),
        value: login([{ label: "User", value: "u", hidden: false }], ""),
      },
      {
        seed: (seeded) =>
          addVault(seeded, {
            name: "saved",
            origin: "https://login.example.test",
            auth: { type: "login" },
            plaintext: login([{ label: "User", value: "u" }], validKey),
          }),
      },
    ),
    put(
      "vput-overwrite-same-destination",
      { destination: destination({ name: "saved" }), value: "new-value" },
      {
        seed: (seeded) =>
          addVault(seeded, {
            name: "saved",
            plaintext: "old-value",
            title: "Kept",
            note: "Kept note",
            policy: "ask",
            allBots: true,
            botIds: ["unused"],
          }),
      },
    ),
    put(
      "vput-overwrite-title-kept",
      { destination: destination({ name: "saved" }), value: "new-value" },
      {
        seed: (seeded) =>
          addVault(seeded, { name: "saved", plaintext: "old-value", title: "Kept", note: "Kept note" }),
      },
    ),
    put(
      "vput-destination-change",
      { destination: destination({ name: "saved", origin: "https://elsewhere.example.test" }), value: "new-value" },
      { seed: (seeded) => addVault(seeded, { name: "saved", plaintext: "old-value" }) },
    ),
    put(
      "vput-bot-ids",
      {
        destination: destination({ name: "saved" }),
        value: "new-value",
        botIds: ["__bot__", "__ba__", "__ba__"],
      },
      {
        seed: async (seeded) => {
          await addBot(seeded, "bot");
          await addBot(seeded, "ba");
          await addVault(seeded, { name: "saved", plaintext: "old-value" });
        },
      },
    ),
    put(
      "vput-all-bots",
      { destination: destination({ name: "saved" }), value: "new-value", allBots: true },
      {
        seed: async (seeded) => {
          await addBot(seeded, "bot");
          await addVault(seeded, {
            name: "saved",
            plaintext: "old-value",
            botIds: ["__bot__"],
            allBots: false,
          });
        },
      },
    ),
    put(
      "vput-bot-ids-unknown",
      { destination: destination({ name: "saved" }), value: "new-value", botIds: ["missing"] },
      { seed: (seeded) => addVault(seeded, { name: "saved", plaintext: "old-value" }) },
    ),
    put(
      "vput-limit",
      { destination: destination({ name: "new-item" }), value: "token-value" },
      {
        seed: async (seeded) => {
          for (let index = 0; index < 100; index += 1)
            await addVault(seeded, {
              name: `item-${String(index).padStart(3, "0")}`,
              plaintext: "value",
              rowId: `${seeded.userId}-limit-${index}`,
            });
        },
      },
    ),
    put(
      "vput-new-item-name-taken",
      { destination: destination({ name: undefined }), value: "token-value", title: "Example" },
      {
        seed: async (seeded) => {
          await addVault(seeded, { name: "example", plaintext: "value" });
          await addVault(seeded, { name: "example-2", plaintext: "value" });
        },
      },
    ),
    put(
      "vput-new-item-untitled",
      { destination: destination({ name: undefined, origin: "https://www.untitled.example.test" }), value: "token-value" },
    ),
    put("vput-new-item-title-slug", {
      destination: destination({ name: undefined, origin: "" , auth: { type: "card" } }),
      value: JSON.stringify({
        number: "5555 5555 5555 4444",
        expMonth: 1,
        expYear: 2032,
        name: "",
      }),
      title: "  Café  Card!!  ",
    }),

    // ---- vault.put: validation shapes ---------------------------------------------------
    put("vput-invalid-missing-destination", { value: "x" }),
    put("vput-invalid-destination-null", { destination: null, value: "x" }),
    put("vput-invalid-destination-string", { destination: "https://example.test", value: "x" }),
    put("vput-invalid-auth-discriminator", { destination: destination({ auth: { type: "bogus" } }), value: "x" }),
    put("vput-invalid-auth-missing", { destination: destination({ auth: {} }), value: "x" }),
    put("vput-invalid-name-regex", { destination: destination({ name: "Bad Name" }), value: "x" }),
    put("vput-invalid-name-long", { destination: destination({ name: `a${"b".repeat(64)}` }), value: "x" }),
    put("vput-invalid-origin-missing", { destination: { name: "x", auth: { type: "bearer" } }, value: "x" }),
    put("vput-invalid-origin-http", { destination: destination({ origin: "http://example.test" }), value: "x" }),
    put("vput-invalid-origin-path", { destination: destination({ origin: "https://example.test/path" }), value: "x" }),
    put("vput-invalid-origin-query", { destination: destination({ origin: "https://example.test/?a=1" }), value: "x" }),
    put("vput-invalid-origin-fragment", { destination: destination({ origin: "https://example.test/#a" }), value: "x" }),
    put("vput-invalid-origin-private", { destination: destination({ origin: "http://192.168.0.4" }), value: "x" }),
    put("vput-invalid-login-http", {
      destination: destination({ origin: "http://login.example.test", auth: { type: "login" } }),
      value: login([{ label: "User", value: "u" }]),
    }),
    put("vput-invalid-header-no-name", { destination: destination({ auth: { type: "header" } }), value: "x" }),
    put("vput-invalid-header-forbidden", {
      destination: destination({ auth: { type: "header", name: "Host" } }),
      value: "x",
    }),
    put("vput-invalid-basic-no-username", { destination: destination({ auth: { type: "basic" } }), value: "x" }),
    put("vput-invalid-basic-colon", {
      destination: destination({ auth: { type: "basic", username: "a:b" } }),
      value: "x",
    }),
    put("vput-invalid-value-empty", { destination: destination(), value: "" }),
    put("vput-invalid-value-long", { destination: destination(), value: "a".repeat(16385) }),
    put("vput-invalid-value-number", { destination: destination(), value: 5 }),
    put("vput-invalid-title-long", { destination: destination(), value: "x", title: "t".repeat(81) }),
    put("vput-invalid-note-long", { destination: destination(), value: "x", note: "n".repeat(201) }),
    put("vput-invalid-policy", { destination: destination(), value: "x", policy: "never" }),
    put("vput-invalid-botIds-too-many", {
      destination: destination(),
      value: "x",
      botIds: Array.from({ length: 101 }, () => "__bot__"),
    }),
    put("vput-invalid-botIds-type", { destination: destination(), value: "x", botIds: "x" }),
    put("vput-invalid-botIds-empty-id", { destination: destination(), value: "x", botIds: [""] }),
    put("vput-invalid-allBots", { destination: destination(), value: "x", allBots: "yes" }),
    put("vput-invalid-alsoOn-too-many", {
      destination: destination(),
      value: "x",
      alsoOn: Array.from({ length: 11 }, () => "https://a.example.test"),
    }),
    put("vput-invalid-alsoOn-element", {
      destination: destination(),
      value: "x",
      alsoOn: ["https://a.example.test", "a".repeat(2049)],
    }),
    put("vput-invalid-alsoOn-type", { destination: destination(), value: "x", alsoOn: {} }),
    put("vput-invalid-scope", { scope: "org", destination: destination(), value: "x" }),
    put("vput-invalid-scope-null", { scope: null, destination: destination(), value: "x" }),
    put("vput-invalid-input-null", null),
    put("vput-invalid-input-array", []),
    put("vput-invalid-input-undefined", undefined),
    put("vput-extra-keys-ok", { destination: destination(), value: "x", more: 1 }, { declines: false }),

    // ---- vault.put: the redaction gate (differential corpus) ----------------------------
    // Accepted names must reach the audit row byte-identical; every accepted name here is
    // compared there. (Go's gate is conservative, so `ck_` and `sk_` names are refused even when
    // the TypeScript redactor would leave them alone: refusal is always safe, a rewrite is not.)
    ...["abcd", "sken", "api-key", "my_keyv2", "credentials"].map((name) =>
      put(`vput-gate-accept-${name.replace(/[^a-z0-9]/g, "")}`, {
        destination: destination({ name }),
        value: "token-value",
      }, { declines: false }),
    ),
    ...["sk-abc", "sk_9", "my-sk-key", "ak_x", "ck_x"].map((name) =>
      put(`vput-gate-decline-${name.replace(/[^a-z0-9]/gi, "")}`, {
        destination: destination({ name }),
        value: "token-value",
      }, { declines: true }),
    ),

    // ---- vault.reveal -------------------------------------------------------------------
    reveal(
      "vreveal-value",
      { name: "saved" },
      {
        seed: async (seeded) => {
          await addVault(seeded, { name: "saved", plaintext: "opened-value", legacy: true });
          await confirm(seeded);
        },
      },
    ),
    reveal(
      "vreveal-rkz1",
      { name: "saved" },
      {
        seed: async (seeded) => {
          await addVault(seeded, { name: "saved", plaintext: "opened-value" });
          await confirm(seeded);
        },
      },
    ),
    reveal("vreveal-no-confirmation", { name: "saved" }, {
      seed: (seeded) => addVault(seeded, { name: "saved", plaintext: "opened-value" }),
    }),
    reveal(
      "vreveal-login",
      { name: "saved" },
      {
        seed: async (seeded) => {
          await addVault(seeded, {
            name: "saved",
            origin: "https://login.example.test",
            auth: { type: "login" },
            plaintext: login(
              [
                { label: "User", value: "alice" },
                { label: "Password", value: "secret", hidden: true },
              ],
              validKey,
            ),
          });
          await confirm(seeded);
        },
      },
    ),
    reveal(
      "vreveal-login-otp-empty",
      { name: "saved" },
      {
        seed: async (seeded) => {
          await addVault(seeded, {
            name: "saved",
            origin: "https://login.example.test",
            auth: { type: "login" },
            plaintext: login([{ label: "User", value: "alice" }], ""),
          });
          await confirm(seeded);
        },
      },
    ),
    reveal(
      "vreveal-login-legacy",
      { name: "saved" },
      {
        seed: async (seeded) => {
          await addVault(seeded, {
            name: "saved",
            origin: "https://login.example.test",
            auth: { type: "login" },
            plaintext: JSON.stringify({ username: "U", password: "P" }),
          });
          await confirm(seeded);
        },
      },
    ),
    reveal(
      "vreveal-card",
      { name: "saved" },
      {
        seed: async (seeded) => {
          await addVault(seeded, {
            name: "saved",
            origin: "",
            auth: { type: "card" },
            plaintext: JSON.stringify({
              number: "4242424242424242",
              expMonth: 4,
              expYear: 2031,
              cvc: "123",
              name: "Alice",
            }),
          });
          await confirm(seeded);
        },
      },
    ),
    reveal(
      "vreveal-contact",
      { name: "saved" },
      {
        seed: async (seeded) => {
          await addVault(seeded, {
            name: "saved",
            origin: "",
            auth: { type: "contact" },
            plaintext: JSON.stringify({ name: "Alice" }),
          });
          await confirm(seeded);
        },
      },
    ),
    reveal("vreveal-missing", { name: "absent" }, { seed: (seeded) => confirm(seeded) }),
    reveal(
      "vreveal-space-override",
      { scope: "space", name: "saved" },
      {
        seed: async (seeded) => {
          await addOverride(seeded);
          await addVault(seeded, { name: "saved", plaintext: "space-value", space: 0 });
          await confirm(seeded);
        },
      },
    ),
    reveal(
      "vreveal-space-default",
      { name: "saved" },
      {
        seed: async (seeded) => {
          await addOverride(seeded);
          await addVault(seeded, { name: "saved", plaintext: "space-value", space: 0 });
          await confirm(seeded);
        },
      },
    ),
    reveal(
      "vreveal-space-no-override",
      { scope: "space", name: "saved" },
      { seed: (seeded) => confirm(seeded) },
    ),
    reveal(
      "vreveal-space-key",
      { scope: "space", name: "saved" },
      {
        seed: async (seeded) => {
          await addOverride(seeded);
          await addVault(seeded, { name: "saved", plaintext: "space-value", space: 0 });
          await confirm(seeded);
        },
      },
    ),
    reveal(
      "vreveal-corrupt-login",
      { name: "saved" },
      {
        seed: async (seeded) => {
          await addVault(seeded, {
            name: "saved",
            origin: "https://login.example.test",
            auth: { type: "login" },
            plaintext: "not a login",
          });
          await confirm(seeded);
        },
      },
    ),
    reveal("vreveal-invalid-name", { name: "" }, { seed: (seeded) => confirm(seeded) }),
    reveal("vreveal-invalid-scope", { scope: "org", name: "saved" }),
    reveal("vreveal-anonymous", { name: "saved" }, { anonymous: true }),

    // ---- vault.remove -------------------------------------------------------------------
    remove(
      "vremove-existing",
      { name: "saved" },
      {
        seed: async (seeded) => {
          await addVault(seeded, { name: "saved", plaintext: "value" });
          await addVault(seeded, { name: "kept", plaintext: "value" });
          await confirm(seeded);
        },
        after: [{ procedure: "vault.list", input: {} }],
      },
    ),
    remove("vremove-absent", { name: "absent" }),
    remove(
      "vremove-space-override",
      { scope: "space", name: "saved" },
      {
        seed: async (seeded) => {
          await addOverride(seeded);
          await addVault(seeded, { name: "saved", plaintext: "value", space: 0 });
          await addVault(seeded, { name: "saved", plaintext: "value" });
        },
      },
    ),
    remove("vremove-space-no-override", { scope: "space", name: "saved" }),
    remove("vremove-gate-sk", { name: "sk-abc" }, { declines: true }),
    remove("vremove-invalid-name", { name: "" }),
    remove("vremove-anonymous", { name: "saved" }, { anonymous: true }),

    // ---- botSecrets.put -----------------------------------------------------------------
    botPut(
      "bput-valid",
      { botId: "__bot__", destination: destination({ name: "bot-item" }), value: "token-value" },
      {
        seed: (seeded) => addBot(seeded, "bot"),
        after: [{ procedure: "botSecrets.list", input: { botId: "__bot__" } }],
      },
    ),
    botPut(
      "bput-archived-bot",
      { botId: "__barch__", destination: destination({ name: "bot-item" }), value: "token-value" },
      { seed: (seeded) => addBot(seeded, "barch", { archivedAt: OLD }) },
    ),
    botPut(
      "bput-missing-bot",
      { botId: "missing", destination: destination({ name: "bot-item" }), value: "token-value" },
    ),
    botPut(
      "bput-space-bot",
      { space: 1, botId: "__bot__", destination: destination({ name: "bot-item" }), value: "token-value" },
      { seed: (seeded) => addBot(seeded, "bot", { spaceId: seeded.spaces[0] }) },
    ),
    botPut(
      "bput-invalid-value",
      { botId: "__bot__", destination: destination({ name: "bot-item" }), value: "" },
      { seed: (seeded) => addBot(seeded, "bot") },
    ),
    botPut(
      "bput-invalid-destination",
      { botId: "__bot__", destination: { name: "bot-item", auth: { type: "bearer" } }, value: "x" },
      { seed: (seeded) => addBot(seeded, "bot") },
    ),
    botPut(
      "bput-invalid-botId",
      { botId: "", destination: destination({ name: "bot-item" }), value: "x" },
    ),
    botPut(
      "bput-gate-decline",
      { botId: "__bot__", destination: destination({ name: "sk-abc" }), value: "x" },
      { seed: (seeded) => addBot(seeded, "bot"), declines: true },
    ),
    botPut(
      "bput-anonymous",
      { botId: "__bot__", destination: destination({ name: "bot-item" }), value: "x" },
      { seed: (seeded) => addBot(seeded, "bot"), anonymous: true },
    ),

    // ---- botSecrets.remove --------------------------------------------------------------
    botRemove(
      "bremove-existing",
      { botId: "__bot__", name: "saved" },
      {
        seed: async (seeded) => {
          await addBot(seeded, "bot");
          await addVault(seeded, { name: "saved", plaintext: "value" });
        },
      },
    ),
    botRemove("bremove-absent", { botId: "__bot__", name: "absent" }, { seed: (seeded) => addBot(seeded, "bot") }),
    botRemove(
      "bremove-archived-bot",
      { botId: "__barch__", name: "saved" },
      { seed: (seeded) => addBot(seeded, "barch", { archivedAt: OLD }) },
    ),
    botRemove(
      "bremove-gate-decline",
      { botId: "__bot__", name: "my-sk-key" },
      { seed: (seeded) => addBot(seeded, "bot"), declines: true },
    ),
    botRemove("bremove-invalid-name", { botId: "__bot__", name: "" }, { seed: (seeded) => addBot(seeded, "bot") }),

    // ---- agentSecrets.put ---------------------------------------------------------------
    agentPut("aput-new", { name: "DEPLOY_KEY", value: "value" }, {
      after: [{ procedure: "agentSecrets.list", input: {} }],
    }),
    agentPut("aput-existing", { name: "DEPLOY_KEY", value: "new-value" }, {
      seed: async (seeded) => {
        await addVault(seeded, { name: "deploy_key", auth: { type: "command" }, plaintext: "old", origin: "" });
      },
    }),
    agentPut("aput-invalid-lower", { name: "deploy_key", value: "x" }),
    agentPut("aput-invalid-dash", { name: "DEPLOY-KEY", value: "x" }),
    agentPut("aput-invalid-empty", { name: "", value: "x" }),
    agentPut("aput-invalid-value-empty", { name: "DEPLOY_KEY", value: "" }),
    agentPut("aput-nul", { name: "DEPLOY_KEY", value: "a\u0000b" }),
    agentPut("aput-surrogate", { name: "DEPLOY_KEY", value: "a\udc00b" }),
    agentPut("aput-not-owner", { space: 2, name: "DEPLOY_KEY", value: "x" }, {
      seed: (seeded) => notSpaceOwner(seeded, 2),
    }),
    agentPut("aput-anonymous", { name: "DEPLOY_KEY", value: "x" }, { anonymous: true }),

    // ---- agentSecrets.remove ------------------------------------------------------------
    agentRemove("aremove-existing", { id: "deploy_key" }, {
      seed: async (seeded) => {
        await addVault(seeded, { name: "deploy_key", auth: { type: "command" }, plaintext: "value", origin: "" });
        await addVault(seeded, { name: "kept_key", auth: { type: "command" }, plaintext: "value", origin: "" });
      },
      after: [{ procedure: "agentSecrets.list", input: {} }],
    }),
    agentRemove("aremove-non-command", { id: "saved" }, {
      seed: (seeded) => addVault(seeded, { name: "saved", plaintext: "value" }),
    }),
    agentRemove("aremove-missing", { id: "absent" }),
    agentRemove("aremove-invalid-empty", { id: "" }),
    agentRemove("aremove-gate-decline-eyj", { id: "eyJhbGciOiJIUzI1NiJ9" }, { declines: true }),
    agentRemove("aremove-gate-decline", { id: "sk-abc" }, {
      seed: async (seeded) => {
        await addVault(seeded, { name: "sk-abc", auth: { type: "command" }, plaintext: "value", origin: "" });
      },
      declines: true,
    }),
    agentRemove("aremove-not-owner", { space: 2, id: "deploy_key" }, {
      seed: async (seeded) => {
        await notSpaceOwner(seeded, 2);
        await addVault(seeded, { name: "deploy_key", auth: { type: "command" }, plaintext: "value", origin: "" });
      },
    }),
    agentRemove("aremove-anonymous", { id: "deploy_key" }, { anonymous: true }),
  ];
}

/**
 * The lane's database evidence: what each write was supposed to change. The runner's own
 * vaultCredentials block compares ids only, and laneJState opens the values; this adds the labels,
 * the bot limits and the audit rows the procedures record.
 */
export async function laneMState(system: System, seeded: Seeded, _procedure?: string) {
  const users = { in: [seeded.userId, `${seeded.userId}-other`] };
  const rows = await system.vaultCredential.findMany({
    where: { userId: users },
    select: {
      id: true,
      userId: true,
      spaceId: true,
      name: true,
      origin: true,
      auth: true,
      title: true,
      note: true,
      policy: true,
      alsoOn: true,
      ciphertext: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { id: "asc" },
  });
  const vault = [];
  for (const row of rows) {
    const opened = await openVaultValue(system, store, row).then(
      (plaintext) => ({ plaintext }),
      (error: Error) => ({ error: error.message }),
    );
    vault.push({
      id: row.id,
      userId: row.userId,
      spaceId: row.spaceId,
      name: row.name,
      origin: row.origin,
      auth: row.auth,
      title: row.title,
      note: row.note,
      policy: row.policy,
      alsoOn: row.alsoOn,
      // The sealed form only: the bytes carry a fresh nonce on each side.
      sealed: row.ciphertext.startsWith("rkz1:") ? "<rkz1>" : row.ciphertext.startsWith("v2:") ? "<v2>" : "<other>",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...opened,
    });
  }
  const bots = await system.vaultCredentialBot.findMany({
    where: { userId: users },
    select: { credentialId: true, botId: true },
    orderBy: [{ credentialId: "asc" }, { botId: "asc" }],
  });
  const limits = await system.vaultCredentialLimit.findMany({
    where: { userId: users },
    select: { credentialId: true },
    orderBy: { credentialId: "asc" },
  });
  // The credential procedures' audit rows. The runner's auditEvents block already covers the
  // case's own organization and actor; this adds the guest's landed rows and the full metadata.
  const audit = await system.auditEvent.findMany({
    where: {
      actorId: { in: [seeded.userId, `${seeded.userId}-other`, `${seeded.userId}-g`] },
      action: { in: ["credential.changed", "credential.deleted", "credential.revealed"] },
    },
    select: {
      organizationId: true,
      spaceId: true,
      spaceName: true,
      actorType: true,
      actorId: true,
      actorLabel: true,
      action: true,
      targetType: true,
      targetId: true,
      targetLabel: true,
      outcome: true,
      metadata: true,
    },
    orderBy: { id: "asc" },
  });
  return { laneM: { vault, bots, limits, audit } };
}
