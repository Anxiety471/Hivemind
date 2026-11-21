/**
 * Lane J cases: the first VAULT slice — bots.rotateWebhookSecret, bots.revealWebhookSecret and
 * pages.remove.
 *
 * Seeds write through the shipped EncryptedSecretStore with the run's test key, so a value Go
 * writes must open in TypeScript and a value TypeScript writes must open in Go; laneJState below
 * opens every lane row on both sides and compares the plaintext, not the ciphertext.
 *
 * vault.remove, botSecrets.remove and agentSecrets.remove are NOT ported: their AUDITED_PROCEDURES
 * metadata carries a free-text item name (`name` / `id`), which the Go redaction gate cannot prove
 * safe without the TypeScript redactor. The pipeline keeps such procedures on proxy
 * (go-port/hook-audit.md's qualification rule; security-audit.ts:62-66 names `approvalRules.remove`
 * for the same reason).
 */
import { EncryptedSecretStore } from "../../../packages/adapters/src/secrets/secrets.js";
import { openVaultValue } from "../../../packages/adapters/src/secrets/vault/vault-values.js";
import { contentEncryptionOf, encryptText } from "../../../packages/db/src/index.js";
import type { Case, Seeded } from "./contract.mts";
import { CONTRACT_ENCRYPTION_KEY } from "./contract-key.mts";

type System = any;

const OLD = new Date(Date.UTC(2022, 4, 1));
const at = (seconds: number) => new Date(OLD.getTime() + seconds * 1000);
const expires = () => new Date(Date.now() + 5 * 60_000);
const store = new EncryptedSecretStore(CONTRACT_ENCRYPTION_KEY);
const sealContext = {
  operationId: "seed",
  traceId: "seed",
  userId: "seed",
  spaceId: "seed",
  signal: new AbortController().signal,
} as never;

async function seal(recordId: string, plaintext: string): Promise<string> {
  return (await store.put(plaintext, sealContext, { recordId })).ciphertext;
}

export function laneJCases(system: System): Case[] {
  const addBot = (
    seeded: Seeded,
    id: string,
    spaceIndex: 0 | 1 | 2 = 0,
    extra: Record<string, unknown> = {},
  ) =>
    system.bot.create({
      data: {
        id: `${seeded.userId}-${id}`,
        spaceId: seeded.spaces[spaceIndex],
        userId: seeded.userId,
        name: id,
        color: "blue",
        createdAt: OLD,
        updatedAt: OLD,
        ...extra,
      },
    });
  const addSecret = async (
    seeded: Seeded,
    id: string,
    plaintext: string,
    extra: Record<string, unknown> = {},
  ) => {
    const ciphertext = await seal(`${seeded.userId}-${id}`, plaintext);
    return system.secret.create({
      data: {
        id: `${seeded.userId}-${id}`,
        userId: seeded.userId,
        spaceId: seeded.spaces[0],
        kind: "webhook",
        ciphertext,
        ...extra,
      },
    });
  };
  const confirm = (seeded: Seeded) =>
    system.verification.create({
      data: {
        id: `${seeded.userId}-confirmation`,
        identifier: `identity-confirmed-${seeded.userId}-session`,
        value: seeded.userId,
        expiresAt: expires(),
      },
    });
  const addPage = (seeded: Seeded, id: string, extra: Record<string, unknown> = {}) =>
    system.page.create({
      data: {
        id: `${seeded.userId}-${id}`,
        spaceId: seeded.spaces[0],
        userId: seeded.userId,
        title: id,
        visibility: "private",
        currentVersion: 1,
        createdAt: OLD,
        updatedAt: OLD,
        ...extra,
      },
    });
  const addShareSecret = async (seeded: Seeded, id: string, plaintext: string) => {
    const ciphertext = await seal(`${seeded.userId}-${id}`, plaintext);
    return system.secret.create({
      data: {
        id: `${seeded.userId}-${id}`,
        userId: seeded.userId,
        spaceId: seeded.spaces[0],
        kind: "page_share",
        ciphertext,
      },
    });
  };
  // A v2 vault row: sealed with the SecretStore key, bound to its record id.
  const addVault = async (
    seeded: Seeded,
    id: string,
    plaintext: string,
    extra: Record<string, unknown> = {},
  ) => {
    const { scope: _scope, vaultSpaceId: _space, ...fields } = extra;
    return system.vaultCredential.create({
      data: {
        id: `${seeded.userId}-${id}`,
        userId: seeded.userId,
        spaceId: null,
        name: "item",
        origin: "https://example.test",
        auth: { type: "value" },
        ciphertext: await seal(`${seeded.userId}-${id}`, plaintext),
        ...fields,
      },
    });
  };
  // An rkz1 vault row under a vault's own content key, as sealVaultValue writes once a key exists.
  const addRkz1Vault = async (
    seeded: Seeded,
    id: string,
    plaintext: string,
    extra: Record<string, unknown> = {},
  ) => {
    const { scope: scopeValue, vaultSpaceId, ...fields } = extra as {
      scope?: string;
      vaultSpaceId?: string;
    } & Record<string, unknown>;
    const scope = scopeValue ?? `user:${seeded.userId}`;
    const ring = contentEncryptionOf(system)!.ring;
    // reset() forgets the Space scopes but not a member's; the row is shredded with the user,
    // so drop the cached key before asking for the current one or the second seed would seal
    // under a key no row holds.
    ring.forget(scope);
    const key = await ring.current(scope);
    const ciphertext = encryptText(
      key,
      { table: "vault_credentials", column: "ciphertext", rowId: `${seeded.userId}-${id}`, owner: seeded.userId },
      plaintext,
    );
    return system.vaultCredential.create({
      data: {
        id: `${seeded.userId}-${id}`,
        userId: seeded.userId,
        spaceId: vaultSpaceId ?? null,
        name: "item",
        origin: "https://example.test",
        auth: { type: "value" },
        ciphertext,
        ...fields,
      },
    });
  };

  const addMaterial = async (
    seeded: Seeded,
    id: string,
    material: Record<string, unknown>,
  ) => {
    const ciphertext = await seal(`${seeded.userId}-${id}`, JSON.stringify(material));
    return system.secret.create({
      data: {
        id: `${seeded.userId}-${id}`,
        userId: seeded.userId,
        spaceId: seeded.spaces[0],
        kind: "mcp",
        ciphertext,
      },
    });
  };
  const addServer = async (
    seeded: Seeded,
    id: string,
    extra: Record<string, unknown> = {},
  ) =>
    system.mcpServer.create({
      data: {
        id: `${seeded.userId}-${id}`,
        spaceId: seeded.spaces[0],
        userId: seeded.userId,
        slug: id,
        name: id,
        transport: "streamable_http",
        ...extra,
      },
    });

  const addModel = async (
    seeded: Seeded,
    id: string,
    provider: string,
    secretText: string,
    extra: Record<string, unknown> = {},
  ) => {
    const { wrongKey, ...fields } = extra as { wrongKey?: boolean } & Record<string, unknown>;
    const recordId = `${seeded.userId}-${id}-secret`;
    const ciphertext = wrongKey
      ? (
          await new EncryptedSecretStore("another-contract-key-0123456789abcdef").put(
            secretText,
            sealContext,
            { recordId },
          )
        ).ciphertext
      : await seal(recordId, secretText);
    await system.secret.create({
      data: {
        id: recordId,
        userId: seeded.userId,
        spaceId: null,
        kind: "model",
        ciphertext,
      },
    });
    const credential = await system.userModelCredential.create({
      data: {
        id: `${seeded.userId}-${id}`,
        userId: seeded.userId,
        provider,
        label: id,
        secretId: recordId,
        ...fields,
      },
    });
    return { ...credential, secretId: recordId, ciphertext };
  };
  const addPreference = (
    seeded: Seeded,
    credentialId: string,
    modelId: string | null,
    thinkingLevel: string | null,
    updatedAt: Date,
  ) =>
    system.userModelPreference.create({
      data: {
        userId: seeded.userId,
        credentialId,
        modelId,
        thinkingLevel,
        createdAt: updatedAt,
        updatedAt,
      },
    });
  const addRoleChoice = (
    seeded: Seeded,
    choice: {
      provider: string;
      modelId: string;
      thinkingLevel?: string;
      credentialId?: string;
    },
  ) =>
    system.userModelRoleChoice.create({
      data: {
        userId: seeded.userId,
        role: "main",
        position: 0,
        provider: choice.provider,
        modelId: choice.modelId,
        thinkingLevel: choice.thinkingLevel ?? null,
        credentialId: choice.credentialId ?? null,
      },
    });

  const base = (name: string, procedure: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `j-${name}`,
    procedure,
    input,
    ...extra,
  });

  return [
    // ---- bots.rotateWebhookSecret -----------------------------------------------------------
    base("rotate-new", "bots.rotateWebhookSecret", { botId: "__s-bot__" }, {
      seed: async (seeded) => {
        await addBot(seeded, "bot");
      },
    }),
    base("rotate-replace", "bots.rotateWebhookSecret", { botId: "__s-bot__" }, {
      seed: async (seeded) => {
        const secret = await addSecret(seeded, "oldwebhook", "old webhook");
        await addBot(seeded, "bot", 0, { webhookSecretId: secret.id });
      },
    }),
    base("rotate-other-space", "bots.rotateWebhookSecret", { botId: "__s-bot__" }, {
      seed: async (seeded) => {
        await addBot(seeded, "bot", 2);
      },
    }),
    base("rotate-other-creator", "bots.rotateWebhookSecret", { botId: "__s-bot__" }, {
      seed: async (seeded) => {
        await system.user.create({
          data: {
            id: `${seeded.userId}-other`,
            name: "Other",
            email: `${seeded.userId}-other@example.test`,
            emailVerified: true,
          },
        });
        await addBot(seeded, "bot", 0, { userId: `${seeded.userId}-other` });
      },
    }),
    base("rotate-archived", "bots.rotateWebhookSecret", { botId: "__s-bot__" }, {
      seed: async (seeded) => {
        await addBot(seeded, "bot", 0, { archivedAt: OLD });
      },
    }),
    base("rotate-missing", "bots.rotateWebhookSecret", { botId: "no-such-bot" }),
    base("rotate-empty-id", "bots.rotateWebhookSecret", { botId: "" }),
    base("rotate-extra-key", "bots.rotateWebhookSecret", { botId: "__s-bot__", extra: 1 }, {
      seed: async (seeded) => {
        await addBot(seeded, "bot");
      },
    }),

    // ---- bots.revealWebhookSecret -----------------------------------------------------------
    base("reveal-ok", "bots.revealWebhookSecret", { botId: "__s-bot__" }, {
      seed: async (seeded) => {
        const secret = await addSecret(seeded, "webhook", "revealed secret");
        await addBot(seeded, "bot", 0, { webhookSecretId: secret.id });
        await confirm(seeded);
      },
    }),
    base("reveal-no-confirmation", "bots.revealWebhookSecret", { botId: "__s-bot__" }, {
      seed: async (seeded) => {
        const secret = await addSecret(seeded, "webhook", "revealed secret");
        await addBot(seeded, "bot", 0, { webhookSecretId: secret.id });
      },
    }),
    base("reveal-other-creator", "bots.revealWebhookSecret", { botId: "__s-bot__" }, {
      seed: async (seeded) => {
        await system.user.create({
          data: {
            id: `${seeded.userId}-other`,
            name: "Other",
            email: `${seeded.userId}-other@example.test`,
            emailVerified: true,
          },
        });
        await addBot(seeded, "bot", 0, { userId: `${seeded.userId}-other` });
      },
    }),
    base("reveal-no-secret", "bots.revealWebhookSecret", { botId: "__s-bot__" }, {
      seed: async (seeded) => {
        await addBot(seeded, "bot");
        await confirm(seeded);
      },
    }),
    base("reveal-foreign-secret", "bots.revealWebhookSecret", { botId: "__s-bot__" }, {
      seed: async (seeded) => {
        const secret = await addSecret(seeded, "webhook", "foreign", { spaceId: seeded.spaces[1] });
        await addBot(seeded, "bot", 0, { webhookSecretId: secret.id });
        await confirm(seeded);
      },
    }),
    base("reveal-tampered", "bots.revealWebhookSecret", { botId: "__s-bot__" }, {
      seed: async (seeded) => {
        const secret = await addSecret(seeded, "webhook", "tampered");
        const body = secret.ciphertext;
        const at = Math.floor(body.length / 2);
        const tampered = `${body.slice(0, at)}${body[at] === "A" ? "B" : "A"}${body.slice(at + 1)}`;
        await system.secret.update({ where: { id: secret.id }, data: { ciphertext: tampered } });
        await addBot(seeded, "bot", 0, { webhookSecretId: secret.id });
        await confirm(seeded);
      },
    }),
    base("reveal-wrong-key", "bots.revealWebhookSecret", { botId: "__s-bot__" }, {
      seed: async (seeded) => {
        const other = new EncryptedSecretStore("another-contract-key-0123456789abcdef");
        const sealed = await other.put("wrong key", sealContext, {
          recordId: `${seeded.userId}-webhook`,
        });
        await system.secret.create({
          data: {
            id: `${seeded.userId}-webhook`,
            userId: seeded.userId,
            spaceId: seeded.spaces[0],
            kind: "webhook",
            ciphertext: sealed.ciphertext,
          },
        });
        await addBot(seeded, "bot", 0, { webhookSecretId: `${seeded.userId}-webhook` });
        await confirm(seeded);
      },
    }),

    // ---- pages.remove -----------------------------------------------------------------------
    base("page-remove-plain", "pages.remove", { pageId: "__s-page__" }, {
      seed: async (seeded) => {
        await addPage(seeded, "page");
      },
    }),
    base("page-remove-link", "pages.remove", { pageId: "__s-page__" }, {
      seed: async (seeded) => {
        const secret = await addShareSecret(seeded, "pageshare", "share-token");
        await addPage(seeded, "page", {
          visibility: "link",
          shareSecretId: secret.id,
          shareTokenHash: "hash",
        });
      },
    }),
    base("page-remove-missing", "pages.remove", { pageId: "no-such-page" }),
    base("page-remove-other", "pages.remove", { pageId: "__s-page__" }, {
      seed: async (seeded) => {
        await system.user.create({
          data: {
            id: `${seeded.userId}-other`,
            name: "Other",
            email: `${seeded.userId}-other@example.test`,
            emailVerified: true,
          },
        });
        await addPage(seeded, "page", { userId: `${seeded.userId}-other` });
      },
    }),
    base("page-remove-extra-key", "pages.remove", { pageId: "__s-page__", extra: 1 }, {
      seed: async (seeded) => {
        await addPage(seeded, "page");
      },
    }),

    // ---- vault.list ------------------------------------------------------------------------
    base("vault-list-empty", "vault.list", undefined),
    base("vault-list-kinds", "vault.list", undefined, {
      seed: async (seeded) => {
        await addVault(seeded, "vvalue", "the value", {
          name: "value-item", title: "Value item", note: "a note", policy: "off",
        });
        await addVault(seeded, "vcommand", "command value", {
          name: "command-item", auth: { type: "command" },
        });
      },
    }),
    base("vault-list-login", "vault.list", undefined, {
      seed: async (seeded) => {
        await addVault(seeded, "vlogin", JSON.stringify({
          fields: [
            { label: "Username", value: "  alice@example.test  ", hidden: false },
            { label: "Password", value: "hunter2", hidden: true },
          ],
          otp: "JBSWY3DPEHPK3PXP",
        }), { name: "login-item", auth: { type: "login" }, alsoOn: ["https://other.example"] });
      },
    }),
    base("vault-list-card", "vault.list", undefined, {
      seed: async (seeded) => {
        await addVault(seeded, "vcard", JSON.stringify({
          number: "4242 4242 4242 4242",
          expMonth: 8,
          expYear: 2029,
          cvc: "123",
          name: "Ada Lovelace",
        }), { name: "card-item", auth: { type: "card" } });
      },
    }),
    base("vault-list-contact", "vault.list", undefined, {
      seed: async (seeded) => {
        await addVault(seeded, "vcontact", JSON.stringify({
          name: " Grace Hopper ",
          city: " Arlington ",
        }), { name: "contact-item", auth: { type: "contact" } });
      },
    }),
    base("vault-list-tampered", "vault.list", undefined, {
      seed: async (seeded) => {
        const row = await addVault(seeded, "vtampered", JSON.stringify({
          fields: [{ label: "Username", value: "u", hidden: false }, { label: "Password", value: "p", hidden: true }],
        }), { name: "tampered-item", auth: { type: "login" } });
        const at = Math.floor(row.ciphertext.length / 2);
        const body = row.ciphertext;
        await system.vaultCredential.update({
          where: { id: row.id },
          data: { ciphertext: `${body.slice(0, at)}${body[at] === "A" ? "B" : "A"}${body.slice(at + 1)}` },
        });
      },
    }),
    base("vault-list-bad-destination", "vault.list", undefined, {
      seed: async (seeded) => {
        await addVault(seeded, "vbad", "value", {
          name: "bad-item",
          origin: "ftp://files.example",
          auth: { type: "login" },
        });
      },
    }),
    base("vault-list-space-scope", "vault.list", undefined, {
      seed: async (seeded) => {
        await system.spaceSettingOverride.create({
          data: { spaceId: seeded.spaces[0], userId: seeded.userId, setting: "credentials" },
        });
        await addVault(seeded, "vspace", "space value", {
          name: "space-item", spaceId: seeded.spaces[0],
        });
        await addVault(seeded, "vaccount", "account value", { name: "account-item" });
      },
    }),
    base("vault-list-space-requested", "vault.list", { scope: "space" }, {
      seed: async (seeded) => {
        await system.spaceSettingOverride.create({
          data: { spaceId: seeded.spaces[0], userId: seeded.userId, setting: "credentials" },
        });
        await addRkz1Vault(seeded, "vspace", JSON.stringify({
          fields: [{ label: "Username", value: "spaceuser", hidden: false }],
        }), { name: "space-item", auth: { type: "login" },
          scope: `vault:${seeded.spaces[0]}`, vaultSpaceId: seeded.spaces[0] });
        await addVault(seeded, "vaccount", "account value", { name: "account-item" });
      },
    }),
    base("vault-list-other-space", "vault.list", undefined, {
      seed: async (seeded) => {
        await addVault(seeded, "velsewhere", "elsewhere", {
          name: "elsewhere", spaceId: seeded.spaces[2],
        });
        await addVault(seeded, "vhere", "here", { name: "here" });
      },
    }),
    base("vault-list-other-user", "vault.list", undefined, {
      seed: async (seeded) => {
        await system.user.create({
          data: {
            id: `${seeded.userId}-other`,
            name: "Other",
            email: `${seeded.userId}-other@example.test`,
            emailVerified: true,
          },
        });
        await system.vaultCredential.create({
          data: {
            id: `${seeded.userId}-vother`,
            userId: `${seeded.userId}-other`,
            spaceId: null,
            name: "other-item",
            origin: "https://other.example",
            auth: { type: "value" },
            ciphertext: await seal("other-vault", "other value"),
          },
        });
        await addVault(seeded, "vmine", "mine", { name: "mine" });
      },
    }),
    base("vault-list-policy", "vault.list", undefined, {
      seed: async (seeded) => {
        await addVault(seeded, "vallow", "a", { name: "a-allow", policy: "allow" });
        await addVault(seeded, "vask", "b", { name: "b-ask", policy: "ask" });
        await addVault(seeded, "vodd", "c", { name: "c-odd", policy: "weird" });
      },
    }),
    base("vault-list-limits", "vault.list", undefined, {
      seed: async (seeded) => {
        await addBot(seeded, "bot");
        const row = await addVault(seeded, "vlimited", "limited", { name: "limited" });
        await addVault(seeded, "vopen", "open", { name: "open" });
        await system.vaultCredentialLimit.create({
          data: { id: `${seeded.userId}-limit`, credentialId: row.id, userId: seeded.userId, spaceId: seeded.spaces[0] },
        });
        await system.vaultCredentialBot.create({
          data: {
            id: `${seeded.userId}-chosen`, credentialId: row.id, botId: `${seeded.userId}-bot`,
            userId: seeded.userId, spaceId: seeded.spaces[0],
          },
        });
      },
    }),
    base("vault-list-rkz1-mix", "vault.list", undefined, {
      seed: async (seeded) => {
        await addVault(seeded, "vv2", JSON.stringify({
          fields: [{ label: "Username", value: "v2user", hidden: false }],
        }), { name: "a-v2", auth: { type: "login" } });
        await addRkz1Vault(seeded, "vrkz", JSON.stringify({
          fields: [{ label: "Username", value: "rkzuser", hidden: false }],
        }), { name: "b-rkz1", auth: { type: "login" } });
      },
    }),

    // ---- botSecrets.list -------------------------------------------------------------------
    base("botsecrets-list-ok", "botSecrets.list", { botId: "__s-bot__" }, {
      seed: async (seeded) => {
        await addBot(seeded, "bot");
        await addVault(seeded, "vitem", JSON.stringify({
          fields: [{ label: "Username", value: "someone", hidden: false }],
        }), { name: "item", auth: { type: "login" } });
      },
    }),
    base("botsecrets-list-missing", "botSecrets.list", { botId: "no-such-bot" }),
    base("botsecrets-list-foreign", "botSecrets.list", { botId: "__s-bot__" }, {
      seed: async (seeded) => {
        await addBot(seeded, "bot", 2);
      },
    }),
    base("botsecrets-list-archived", "botSecrets.list", { botId: "__s-bot__" }, {
      seed: async (seeded) => {
        await addBot(seeded, "bot", 0, { archivedAt: OLD });
      },
    }),

    // ---- mcp.servers.list ------------------------------------------------------------------
    base("mcp-list-empty", "mcp.servers.list", undefined),
    base("mcp-list-fields", "mcp.servers.list", undefined, {
      seed: async (seeded) => {
        const material = await addMaterial(seeded, "msecret", {
          secret: "a-token",
          env: { B_TOKEN: "b", A_TOKEN: "a" },
          files: { CONFIG: "template" },
          headers: { "X-Api-Key": "a", "X-Other": "b" },
          oauthClient: { client_id: "client-123" },
          oauth: { tokens: { access_token: "x" } },
        });
        await addServer(seeded, "server", {
          endpoint: "https://mcp.example/sse",
          transport: "sse",
          args: ["--legacy", 3, "--second"],
          env: { SECOND: "2", FIRST: "1" },
          files: { FILE_B: "b", FILE_A: "a" },
          headers: { "X-One": "1" },
          secretId: material.id,
          healthStatus: "ok",
          healthToolCount: 7,
        });
      },
    }),
    base("mcp-list-states", "mcp.servers.list", undefined, {
      seed: async (seeded) => {
        await addServer(seeded, "none", { slug: "a-none" });
        const reconnect = await addMaterial(seeded, "reconnect", { oauth: { generation: 1 } });
        await addServer(seeded, "reconnect", { slug: "b-reconnect", secretId: reconnect.id });
        const connected = await addMaterial(seeded, "connected", {
          oauth: { tokens: { access_token: "x" } },
        });
        await addServer(seeded, "connected", { slug: "c-connected", secretId: connected.id });
      },
    }),
    base("mcp-list-tampered", "mcp.servers.list", undefined, {
      seed: async (seeded) => {
        const material = await addMaterial(seeded, "broken", { secret: "x" });
        const body = material.ciphertext;
        const at = Math.floor(body.length / 2);
        await system.secret.update({
          where: { id: material.id },
          data: { ciphertext: `${body.slice(0, at)}${body[at] === "A" ? "B" : "A"}${body.slice(at + 1)}` },
        });
        await addServer(seeded, "broken", { slug: "broken", secretId: material.id });
      },
    }),
    base("mcp-list-other-user", "mcp.servers.list", undefined, {
      seed: async (seeded) => {
        await system.user.create({
          data: {
            id: `${seeded.userId}-other`,
            name: "Other",
            email: `${seeded.userId}-other@example.test`,
            emailVerified: true,
          },
        });
        await addServer(seeded, "other", { slug: "other", userId: `${seeded.userId}-other` });
        await addServer(seeded, "mine", { slug: "mine" });
      },
    }),
    base("mcp-list-visibility", "mcp.servers.list", undefined, {
      seed: async (seeded) => {
        await addServer(seeded, "elsewhere", { slug: "elsewhere", spaceId: seeded.spaces[2] });
        await addServer(seeded, "allspaces", { slug: "allspaces", allSpaces: true });
        const shared = await addServer(seeded, "shared", { slug: "shared" });
        await system.mcpServerSpace.create({
          data: { serverId: shared.id, spaceId: seeded.spaces[1], userId: seeded.userId },
        });
      },
    }),
    base("mcp-list-health", "mcp.servers.list", undefined, {
      seed: async (seeded) => {
        await addServer(seeded, "needsclient", {
          slug: "needsclient",
          healthStatus: "error",
          healthMessage: "Incompatible auth server: does not support dynamic client registration",
        });
        await addServer(seeded, "othererror", {
          slug: "othererror",
          healthStatus: "error",
          healthMessage: "connection refused",
        });
        await addServer(seeded, "oddstatus", { slug: "oddstatus", healthStatus: "weird" });
      },
    }),
    base("mcp-list-bad-transport", "mcp.servers.list", undefined, {
      seed: async (seeded) => {
        await addServer(seeded, "bad", { slug: "bad", transport: "carrier-pigeon" });
      },
    }),

    // ---- models.credentials -----------------------------------------------------------------
    base("model-credentials-empty", "models.credentials", undefined),
    base("model-credentials-api-key", "models.credentials", undefined, {
      seed: async (seeded) => {
        await addModel(seeded, "key", "anthropic", "sk-ant-raw-key");
      },
    }),
    base("model-credentials-api-key-json", "models.credentials", undefined, {
      seed: async (seeded) => {
        await addModel(seeded, "keyjson", "openai", JSON.stringify({
          kind: "api_key",
          key: "sk-openai",
          maxTokens: 1024,
          contextWindow: 8192,
          accountId: "acct-1",
          gatewayId: "gateway-1",
          projectId: "project-1",
          region: "eu",
          cacheCapabilities: {
            scope: "connection", retentionMs: 60000, minimumTokens: 128,
            retentionMode: "short", inputCostPerMillion: 3, readCostPerMillion: 0.3,
            writeCostPerMillion: 3.75,
          },
          models: { "gpt-5": { maxTokens: 512, contextWindow: 4096, reasoning: true } },
        }));
      },
    }),
    base("model-credentials-oauth", "models.credentials", undefined, {
      seed: async (seeded) => {
        await addModel(seeded, "oauth", "openai-codex", JSON.stringify({
          kind: "oauth",
          credential: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: 1_900_000_000_000 },
          maxTokens: 2048,
        }));
        await addModel(seeded, "legacy", "openai-codex", JSON.stringify({
          type: "oauth", access: "legacy-access", refresh: "legacy-refresh", expires: 1_900_000_000_000,
        }));
      },
    }),
    base("model-credentials-oauth-reconnect", "models.credentials", undefined, {
      seed: async (seeded) => {
        await addModel(seeded, "reconnect", "openai-codex", JSON.stringify({
          kind: "oauth", reconnectRequired: true, maxTokens: 4096,
          models: { "gpt-5": { reasoning: false } },
        }));
      },
    }),
    base("model-credentials-unreadable", "models.credentials", undefined, {
      seed: async (seeded) => {
        const row = await addModel(seeded, "tampered", "anthropic", "sk-ant-tampered");
        const body = row.ciphertext;
        const at = Math.floor(body.length / 2);
        await system.secret.update({
          where: { id: row.secretId },
          data: { ciphertext: `${body.slice(0, at)}${body[at] === "A" ? "B" : "A"}${body.slice(at + 1)}` },
        });
        await addModel(seeded, "wrongkey", "anthropic", "sk-ant-wrong-key", { wrongKey: true });
        await system.userModelCredential.create({
          data: {
            id: `${seeded.userId}-missing`,
            userId: seeded.userId,
            provider: "anthropic",
            label: "missing",
            secretId: `${seeded.userId}-no-such-secret`,
          },
        });
      },
    }),
    base("model-credentials-preferences", "models.credentials", undefined, {
      seed: async (seeded) => {
        const first = await addModel(seeded, "older", "anthropic", "sk-ant-older", { updatedAt: at(1) });
        const second = await addModel(seeded, "newer", "anthropic", "sk-ant-newer", { updatedAt: at(2) });
        await addPreference(seeded, first.id, "claude-sonnet-4", "high", at(10));
        await addPreference(seeded, second.id, "claude-opus-4", "medium", at(20));
      },
    }),
    base("model-credentials-main-choice", "models.credentials", undefined, {
      seed: async (seeded) => {
        const chosen = await addModel(seeded, "main", "anthropic", "sk-ant-main", { updatedAt: at(1) });
        await addModel(seeded, "other", "openai", "sk-openai-other", { updatedAt: at(2) });
        await addPreference(seeded, chosen.id, "claude-haiku-4", "low", at(5));
        await addRoleChoice(seeded, {
          provider: "anthropic", modelId: "claude-sonnet-4", thinkingLevel: "high",
          credentialId: chosen.id,
        });
      },
    }),
    base("model-credentials-main-preference", "models.credentials", undefined, {
      seed: async (seeded) => {
        const preferred = await addModel(seeded, "preferred", "anthropic", "sk-ant-preferred", { updatedAt: at(1) });
        await addModel(seeded, "newest", "anthropic", "sk-ant-newest", { updatedAt: at(2) });
        await addPreference(seeded, preferred.id, "claude-sonnet-4", "medium", at(9));
        await addRoleChoice(seeded, { provider: "anthropic", modelId: "claude-sonnet-4" });
      },
    }),
    base("model-credentials-main-newest", "models.credentials", undefined, {
      seed: async (seeded) => {
        await addModel(seeded, "older", "anthropic", "sk-ant-older", { updatedAt: at(1) });
        await addModel(seeded, "newest", "anthropic", "sk-ant-newest", { updatedAt: at(2) });
        await addRoleChoice(seeded, { provider: "anthropic", modelId: "claude-sonnet-4" });
      },
    }),
    base("model-credentials-space-main", "models.credentials", undefined, {
      seed: async (seeded) => {
        const account = await addModel(seeded, "account", "anthropic", "sk-ant-account", { updatedAt: at(1) });
        const space = await addModel(seeded, "space", "openai", "sk-openai-space", { updatedAt: at(2) });
        await system.spaceSettingOverride.create({
          data: { spaceId: seeded.spaces[0], userId: seeded.userId, setting: "models" },
        });
        await system.spaceModelRoleChoice.create({
          data: {
            spaceId: seeded.spaces[0], userId: seeded.userId, role: "main", position: 0,
            provider: "openai", modelId: "gpt-5", thinkingLevel: "low", credentialId: space.id,
          },
        });
        await system.userModelRoleChoice.create({
          data: {
            userId: seeded.userId, role: "main", position: 0, provider: "anthropic",
            modelId: "claude-sonnet-4", credentialId: account.id,
          },
        });
      },
    }),
    base("model-credentials-other-user", "models.credentials", undefined, {
      seed: async (seeded) => {
        await system.user.create({
          data: {
            id: `${seeded.userId}-other`,
            name: "Other",
            email: `${seeded.userId}-other@example.test`,
            emailVerified: true,
          },
        });
        await addModel(seeded, "mine", "anthropic", "sk-ant-mine");
        const ciphertext = await seal("other-model", "sk-ant-other");
        await system.secret.create({
          data: {
            id: `${seeded.userId}-other-secret`, userId: `${seeded.userId}-other`,
            spaceId: null, kind: "model", ciphertext,
          },
        });
        await system.userModelCredential.create({
          data: {
            id: `${seeded.userId}-other-model`, userId: `${seeded.userId}-other`,
            provider: "anthropic", label: "other", secretId: `${seeded.userId}-other-secret`,
          },
        });
      },
    }),
    base("model-credentials-compatible", "models.credentials", undefined, {
      seed: async (seeded) => {
        await addModel(seeded, "compat", "openai-compatible", JSON.stringify({
          kind: "openai_compatible",
          baseUrl: "https://ollama.com/v1",
          apiProtocol: "responses",
          headers: { "X-Api-Key": "secret-value", "X-Second": "two" },
          apiKey: "sk-compatible",
          reasoning: false,
          maxTokens: 512,
          contextWindow: 8192,
          visionModelIds: ["vision-model"],
          enabledModelIds: ["model-a", "vision-model"],
          maxImagesPerPrompt: 3,
          cacheCapabilities: { scope: "account" },
          models: { "model-a": { images: true, reasoning: true } },
        }), { supportsImages: true });
      },
    }),
    base("model-credentials-compatible-reasoning", "models.credentials", undefined, {
      seed: async (seeded) => {
        await addModel(seeded, "reasoning", "openai-compatible", JSON.stringify({
          kind: "openai_compatible",
          baseUrl: "https://api.longcat.chat/openai",
          reasoning: true,
          enabledModelIds: ["model-b"],
        }));
      },
    }),
    base("model-credentials-compatible-main-other", "models.credentials", undefined, {
      seed: async (seeded) => {
        const first = await addModel(seeded, "first", "openai-compatible", JSON.stringify({
          kind: "openai_compatible", baseUrl: "https://example.test/v1",
          enabledModelIds: ["model-a"],
        }), { updatedAt: at(2) });
        const enabling = await addModel(seeded, "enabling", "openai-compatible", JSON.stringify({
          kind: "openai_compatible", baseUrl: "https://example.test/v1",
          enabledModelIds: ["model-b"],
        }), { updatedAt: at(1) });
        await addRoleChoice(seeded, { provider: "openai-compatible", modelId: "model-b" });
        void first;
        void enabling;
      },
    }),
  ];
}

/** Opens one lane row on both sides so the state comparison sees the plaintext, not ciphertext. */
export async function laneJState(system: System, seeded: Seeded, _procedure?: string) {
  const owners = { in: [seeded.userId, `${seeded.userId}-other`] };
  const ring = contentEncryptionOf(system)?.ring;
  const vaultRows = await system.vaultCredential.findMany({
    where: { userId: owners },
    select: { id: true, userId: true, spaceId: true, name: true, auth: true, ciphertext: true },
    orderBy: { id: "asc" },
  });
  const vault = [];
  for (const row of vaultRows) {
    const value = await openVaultValue(system, store, row).then(
      (plaintext) => ({ plaintext }),
      (error: Error) => ({ error: error.message }),
    );
    vault.push({
      id: row.id,
      userId: row.userId,
      spaceId: row.spaceId,
      name: row.name,
      authType: row.auth?.type ?? null,
      ...value,
    });
  }
  const secretRows = await system.secret.findMany({
    where: { userId: owners },
    select: { id: true, userId: true, spaceId: true, kind: true, ciphertext: true },
    orderBy: { id: "asc" },
  });
  const secrets = [];
  for (const row of secretRows) {
    const value = await store.load(row.ciphertext, row.id).then(
      (plaintext) => ({ plaintext }),
      (error: Error) => ({ error: error.message }),
    );
    secrets.push({ id: row.id, userId: row.userId, spaceId: row.spaceId, kind: row.kind, ...value });
  }
  const securityRows = await system.securityEvent.findMany({
    where: { userId: owners },
    select: { type: true, userId: true, spaceId: true, metadata: true },
    orderBy: { createdAt: "asc" },
  });
  // A generated secret id is random on each side, so the database order differs; compare the rows
  // by what they mean (owner, Space, kind, opened value), not by their ids.
  const stable = (row: any) =>
    JSON.stringify([row.userId, row.spaceId, row.kind ?? row.name, row.plaintext ?? row.error]);
  vault.sort((left, right) => stable(left).localeCompare(stable(right)));
  secrets.sort((left, right) => stable(left).localeCompare(stable(right)));
  securityRows.sort((left: any, right: any) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const jobs = await system.$queryRaw<any[]>`
    SELECT count(*)::int AS count FROM graphile_worker._private_jobs
    WHERE payload->>'kind' = 'secret.cleanup'`;
  return {
    laneJ: {
      vault,
      secrets,
      security: securityRows.map((row: any) => ({
        type: row.type,
        userId: row.userId,
        spaceId: row.spaceId,
        metadata: row.metadata,
      })),
      cleanupJobs: jobs[0]?.count ?? 0,
    },
  };
}
