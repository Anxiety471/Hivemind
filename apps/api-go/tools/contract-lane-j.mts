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
import { contentEncryptionOf } from "../../../packages/db/src/index.js";
import type { Case, Seeded } from "./contract.mts";
import { CONTRACT_ENCRYPTION_KEY } from "./contract-key.mts";

type System = any;

const OLD = new Date(Date.UTC(2022, 4, 1));
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
