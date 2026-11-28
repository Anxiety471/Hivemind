/**
 * Lane M bot and agent cases: botSecrets.put/remove and agentSecrets.put/remove.
 */
import type { System } from "./contract-m-secrets-helpers.mts";
import { OLD } from "./contract-m-secrets-helpers.mts";
import type { Case } from "./contract.mts";
import { laneMHelpers } from "./contract-m-secrets-helpers.mts";

export function laneMBotCases(system: System): Case[] {
  const {
    addVault,
    addBot,
    notSpaceOwner,
    command,
    botPut,
    botRemove,
    agentPut,
    agentRemove,
    destination,
  } = laneMHelpers(system);
  return [
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
