/**
 * Shared pieces of the Lane M secret-store cases: the seed rows and the request-shape builders
 * (put, remove, reveal, botPut, ...). Each case file calls laneMHelpers(system) and takes only
 * the helpers it uses.
 */
import { EncryptedSecretStore } from "../../../packages/adapters/src/secrets/secrets.js";
import { contentEncryptionOf, encryptText } from "../../../packages/db/src/index.js";
import { CONTRACT_ENCRYPTION_KEY } from "./contract-key.mts";
import type { Case, Seeded } from "./contract.mts";

export type System = any;

export const OLD = new Date(Date.UTC(2021, 3, 2));
export const store = new EncryptedSecretStore(CONTRACT_ENCRYPTION_KEY);
export const sealContext = {
  operationId: "seed",
  traceId: "seed",
  userId: "seed",
  spaceId: "seed",
  signal: new AbortController().signal,
} as never;

/** The legacy record form: sealed by the credential store, bound to its record id. */
export async function v2(recordId: string, plaintext: string): Promise<string> {
  return (await store.put(plaintext, sealContext, { recordId })).ciphertext;
}

export type VaultSeed = {
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

export function laneMHelpers(system: System) {
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

  return {
    vaultScope,
    addVault,
    spaceOf,
    addBot,
    addOverride,
    makeGuest,
    notSpaceOwner,
    confirm,
    login,
    command,
    validKey,
    put,
    remove,
    reveal,
    botPut,
    botRemove,
    agentPut,
    agentRemove,
    destination,
  };
}
