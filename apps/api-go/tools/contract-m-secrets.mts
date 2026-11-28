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
import { openVaultValue } from "../../../packages/adapters/src/secrets/vault/vault-values.js";
import type { System } from "./contract-m-secrets-helpers.mts";
import { store } from "./contract-m-secrets-helpers.mts";
import type { Case, Seeded } from "./contract.mts";
import { laneMBotCases } from "./contract-m-secrets-bots.mts";
import { laneMVaultCases } from "./contract-m-secrets-vault.mts";

export function laneMSecretCases(system: System): Case[] {
  return [...laneMVaultCases(system), ...laneMBotCases(system)];
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
  // The row ids a case creates are random on each side, so the SQL id order would put the same
  // rows in different places. Every field in this key is compared, so a difference still shows.
  const sortKey = (row: { name: string; spaceId: string | null; userId: string }) =>
    [row.name, row.spaceId ?? "", row.userId].join("\u0000");
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
  vault.sort((left, right) => sortKey(left).localeCompare(sortKey(right)));
  const bots = await system.vaultCredentialBot.findMany({
    where: { userId: users },
    select: { credentialId: true, botId: true },
    orderBy: [{ credentialId: "asc" }, { botId: "asc" }],
  });
  bots.sort((left: { botId: string }, right: { botId: string }) =>
    left.botId.localeCompare(right.botId));
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
  // Same reason as the vault rows: audit ids are per side, while the landings and their metadata
  // are what must match.
  audit.sort((left: { action: string }, right: { action: string }) =>
    JSON.stringify([
      left.action,
      (left as { actorId?: string }).actorId,
      (left as { organizationId?: string | null }).organizationId,
      (left as { spaceId?: string | null }).spaceId,
      JSON.stringify((left as { metadata?: unknown }).metadata),
    ]).localeCompare(
      JSON.stringify([
        right.action,
        (right as { actorId?: string }).actorId,
        (right as { organizationId?: string | null }).organizationId,
        (right as { spaceId?: string | null }).spaceId,
        JSON.stringify((right as { metadata?: unknown }).metadata),
      ]),
    ),
  );
  return { laneM: { vault, bots, limits, audit } };
}
