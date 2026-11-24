/**
 * models.role and models.setRole: the member's ordered models for a purpose, what the
 * deployment runs when none is chosen, and the save that validates the whole list.
 *
 * The credential rows for native providers need no readable secret: validation finds the
 * connection and checks the catalog. A compatible server's row compares against its sealed
 * secret and saved preference, so those seed one through the shipped store with the run's
 * test key.
 */
import { EncryptedSecretStore } from "../../../packages/adapters/src/secrets/secrets.js";
import type { Case, Seeded } from "./contract.mts";
import { CONTRACT_ENCRYPTION_KEY } from "./contract-key.mts";

type System = any;
let system: System;

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

async function seedOtherMember(seeded: Seeded) {
  const id = `${seeded.userId}-other`;
  await system.user.create({
    data: { id, name: "Other", email: `${id}@example.test`, emailVerified: true },
  });
  return id;
}

/** A connection on one provider, with a secret row the runtime cannot open unless sealed. */
async function addCredential(
  seeded: Seeded,
  id: string,
  provider: string,
  extra: Record<string, unknown> = {},
) {
  const secretId = `${seeded.userId}-${id}-secret`;
  await system.secret.create({
    data: {
      id: secretId,
      userId: seeded.userId,
      spaceId: null,
      kind: "model",
      ciphertext: "sealed",
    },
  });
  await system.userModelCredential.create({
    data: {
      id: `${seeded.userId}-${id}`,
      userId: seeded.userId,
      provider,
      label: id,
      secretId,
      ...extra,
    },
  });
  return `${seeded.userId}-${id}`;
}

function addChoice(
  seeded: Seeded,
  role: string,
  position: number,
  provider: string,
  modelId: string,
  extra: { thinkingLevel?: string | null; credentialId?: string | null; space?: string } = {},
) {
  const data = {
    userId: seeded.userId,
    role,
    position,
    provider,
    modelId,
    thinkingLevel: extra.thinkingLevel ?? null,
    credentialId: extra.credentialId ?? null,
  };
  if (extra.space)
    return system.spaceModelRoleChoice.create({ data: { ...data, spaceId: extra.space } });
  return system.userModelRoleChoice.create({ data });
}

/** An account chain of three models on their own connections, plus an approval and computer row. */
function seedRole(seeded: Seeded) {
  return (async () => {
    await seedOtherMember(seeded);
    const anthropic = await addCredential(seeded, "anthropic", "anthropic");
    const compatibleSecretId = `${seeded.userId}-compatible-secret`;
    await system.secret.create({
      data: {
        id: compatibleSecretId,
        userId: seeded.userId,
        spaceId: null,
        kind: "model",
        ciphertext: await seal(
          compatibleSecretId,
          JSON.stringify({
            kind: "openai_compatible",
            baseUrl: "https://models.example.test/v1",
            apiKey: "test-key",
            enabledModelIds: ["custom-vision"],
            visionModelIds: ["custom-vision"],
          }),
        ),
      },
    });
    const compatible = `${seeded.userId}-compatible`;
    await system.userModelCredential.create({
      data: {
        id: compatible,
        userId: seeded.userId,
        provider: "openai-compatible",
        label: "Compatible",
        secretId: compatibleSecretId,
        supportsImages: true,
      },
    });
    await system.userModelPreference.create({
      data: { userId: seeded.userId, credentialId: compatible, modelId: "custom-vision" },
    });
    const deepseek = await addCredential(seeded, "deepseek", "deepseek");
    await addChoice(seeded, "main", 0, "anthropic", "claude-haiku-5-5", {
      thinkingLevel: "high",
      credentialId: anthropic,
    });
    await addChoice(seeded, "main", 1, "openai-compatible", "custom-vision", {
      credentialId: compatible,
    });
    await addChoice(seeded, "main", 2, "deepseek", "deepseek-v4-pro", {
      credentialId: deepseek,
    });
    await addChoice(seeded, "approval", 0, "anthropic", "claude-haiku-5-5", {
      credentialId: anthropic,
    });
    await addChoice(seeded, "computer", 0, "anthropic", "claude-haiku-5-5", {
      credentialId: anthropic,
    });
  })();
}

/** The same chain in the Space's copy, with the Space overriding models. */
function seedSpaceRole(seeded: Seeded) {
  return (async () => {
    await seedOtherMember(seeded);
    const anthropic = await addCredential(seeded, "anthropic", "anthropic");
    await system.spaceSettingOverride.create({
      data: { spaceId: seeded.spaces[0], userId: seeded.userId, setting: "models" },
    });
    await addChoice(seeded, "main", 0, "anthropic", "claude-haiku-5-5", {
      credentialId: anthropic,
      space: seeded.spaces[0],
    });
    await addChoice(seeded, "main", 1, "deepseek", "deepseek-v4-pro", {
      space: seeded.spaces[0],
    });
  })();
}

/** Credentials for the save cases: anthropic, deepseek and a compatible server. */
function seedSaveCredentials(seeded: Seeded) {
  return (async () => {
    await addCredential(seeded, "anthropic", "anthropic");
    await addCredential(seeded, "deepseek", "deepseek");
    const secretId = `${seeded.userId}-compatible-secret`;
    await system.secret.create({
      data: {
        id: secretId,
        userId: seeded.userId,
        spaceId: null,
        kind: "model",
        ciphertext: await seal(
          secretId,
          JSON.stringify({
            kind: "openai_compatible",
            baseUrl: "https://models.example.test/v1",
            apiKey: "test-key",
            enabledModelIds: ["custom-vision"],
            visionModelIds: ["custom-vision"],
          }),
        ),
      },
    });
    await system.userModelCredential.create({
      data: {
        id: `${seeded.userId}-compatible`,
        userId: seeded.userId,
        provider: "openai-compatible",
        label: "Compatible",
        secretId,
        supportsImages: true,
      },
    });
  })();
}

function roleCases(): Case[] {
  const role = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `model-role-${name}`,
    procedure: "models.role",
    input,
    ...extra,
  });
  return [
    role("empty-main", { role: "main" }),
    role("empty-approval", { role: "approval" }),
    role("empty-computer", { role: "computer" }),
    role("account-chain", { role: "main" }, { seed: seedRole }),
    role("approval-row", { role: "approval" }, { seed: seedRole }),
    role("computer-row", { role: "computer" }, { seed: seedRole }),
    role("space-copy", { role: "main", scope: "space" }, { seed: seedSpaceRole }),
    role(
      "account-copy-behind-space-override",
      { role: "main", scope: "account" },
      {
        seed: seedSpaceRole,
      },
    ),
    role("space-header-uses-the-copy", { role: "main" }, { seed: seedSpaceRole }),
    role("expected-other", { role: "main", expectedUserId: "someone-else" }),
    role("expected-self", { role: "main", expectedUserId: "__user__" }),
    role("anonymous", { role: "main" }, { anonymous: true }),
    role("bad-role", { role: "summary" }),
    role("no-input", undefined),
  ];
}

function setRoleCases(): Case[] {
  const save = (name: string, input: unknown, extra: Partial<Case> = {}): Case => ({
    name: `model-set-${name}`,
    procedure: "models.setRole",
    input,
    seed: seedSaveCredentials,
    ...extra,
  });
  return [
    save("chain", {
      role: "main",
      primary: { provider: "anthropic", modelId: "claude-haiku-5-5", thinkingLevel: "high" },
      backups: [
        { provider: "openai-compatible", modelId: "custom-vision" },
        { provider: "deepseek", modelId: "deepseek-v4-pro" },
      ],
    }),
    save("null-primary", { role: "main", primary: null }),
    save("clear-thinking", {
      role: "main",
      primary: { provider: "anthropic", modelId: "claude-haiku-5-5", thinkingLevel: null },
    }),
    save("drops-primary-from-backups", {
      role: "main",
      primary: { provider: "anthropic", modelId: "claude-haiku-5-5" },
      backups: [{ provider: "anthropic", modelId: "claude-haiku-5-5" }],
    }),
    save(
      "keeps-saved-thinking",
      {
        role: "main",
        primary: { provider: "anthropic", modelId: "claude-haiku-5-5" },
      },
      {
        seed: async (seeded: Seeded) => {
          await seedSaveCredentials(seeded);
          await addChoice(seeded, "main", 0, "anthropic", "claude-haiku-5-5", {
            thinkingLevel: "low",
            credentialId: `${seeded.userId}-anthropic`,
          });
        },
      },
    ),
    save("computer-vision", {
      role: "computer",
      primary: { provider: "anthropic", modelId: "claude-haiku-5-5" },
    }),
    save("computer-no-vision", {
      role: "computer",
      primary: { provider: "deepseek", modelId: "deepseek-v4-pro" },
    }),
    save("thinking-not-offered", {
      role: "main",
      primary: { provider: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: "low" },
    }),
    save("unknown-native-model", {
      role: "main",
      primary: { provider: "anthropic", modelId: "claude-not-real" },
    }),
    save("provider-not-connected", {
      role: "main",
      primary: { provider: "google", modelId: "gemini-2.5-pro" },
    }),
    save("compatible-saved-preference", {
      role: "main",
      primary: {
        provider: "openai-compatible",
        modelId: "custom-vision",
        credentialId: "__user__-compatible",
      },
    }),
    save("compatible-not-enabled", {
      role: "main",
      primary: { provider: "openai-compatible", modelId: "not-enabled" },
    }),
    save("duplicate-backups", {
      role: "main",
      backups: [
        { provider: "anthropic", modelId: "claude-haiku-5-5" },
        { provider: "anthropic", modelId: "claude-haiku-5-5" },
      ],
    }),
    save("too-many-backups", {
      role: "main",
      backups: Array.from({ length: 11 }, (_, index) => ({
        provider: "anthropic",
        modelId: `model-${index}`,
      })),
    }),
    save("expected-other", {
      role: "main",
      expectedUserId: "someone-else",
      primary: { provider: "anthropic", modelId: "claude-haiku-5-5" },
    }),
    save(
      "anonymous",
      {
        role: "main",
        primary: { provider: "anthropic", modelId: "claude-haiku-5-5" },
      },
      { anonymous: true },
    ),
  ].map((testCase) => ({
    ...testCase,
    after: [{ procedure: "models.role", input: { role: "main" } }],
  }));
}

export function modelsCases(db: System): Case[] {
  system = db;
  return [...roleCases(), ...setRoleCases()];
}
