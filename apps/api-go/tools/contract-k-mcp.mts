/**
 * Lane K cases: the MCP completion writes — mcp.assignments.dismiss, mcp.assignments.replace,
 * mcp.servers.agents, mcp.servers.remove and mcp.oauth.disconnect.
 *
 * Placeholders: `__s-<name>__` expands to `<userId>-<name>` (contract.mts withIds), so reset owns
 * every row a case seeds. Sealed credentials are written with the shipped EncryptedSecretStore
 * and the run's test key: laneJState opens every secret row on both sides, so a material Go writes
 * must equal JSON.stringify of the material TypeScript keeps, byte for byte (key order included).
 */
import { EncryptedSecretStore } from "../../../packages/adapters/src/secrets/secrets.js";
import type { Case, Seeded } from "./contract.mts";
import { CONTRACT_ENCRYPTION_KEY } from "./contract-key.mts";

type System = any;

const OLD = new Date(Date.UTC(2022, 4, 1));
const at = (seconds: number) => new Date(OLD.getTime() + seconds * 1000);
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

export function laneKCases(system: System): Case[] {
  const id = (seeded: Seeded, name: string) => `${seeded.userId}-${name}`;

  const bot = (seeded: Seeded, name: string, spaceIndex: 0 | 1 | 2 = 0, extra = {}) =>
    system.bot.create({
      data: {
        id: id(seeded, name),
        spaceId: seeded.spaces[spaceIndex],
        userId: seeded.userId,
        name,
        color: "blue",
        createdAt: OLD,
        updatedAt: OLD,
        ...extra,
      },
    });

  const thread = (seeded: Seeded, name: string, botName?: string, spaceIndex: 0 | 1 | 2 = 0) =>
    system.thread.create({
      data: {
        id: id(seeded, name),
        spaceId: seeded.spaces[spaceIndex],
        userId: seeded.userId,
        botId: botName ? id(seeded, botName) : null,
      },
    });

  const group = async (seeded: Seeded, name: string, botNames: string[]) => {
    await system.chatGroup.create({
      data: {
        id: id(seeded, name),
        spaceId: seeded.spaces[0],
        userId: seeded.userId,
        name,
        createdAt: OLD,
        updatedAt: OLD,
      },
    });
    for (const [index, botName] of botNames.entries()) {
      await system.chatGroupMember.create({
        data: {
          id: id(seeded, `${name}m${index}`),
          groupId: id(seeded, name),
          botId: id(seeded, botName),
          createdAt: OLD,
        },
      });
    }
  };

  const groupThread = (seeded: Seeded, name: string, groupName: string) =>
    system.thread.create({
      data: {
        id: id(seeded, name),
        spaceId: seeded.spaces[0],
        userId: seeded.userId,
        groupId: id(seeded, groupName),
      },
    });

  const server = (
    seeded: Seeded,
    name: string,
    extra: Record<string, unknown> = {},
    spaceIndex: 0 | 1 | 2 = 0,
    userId = seeded.userId,
  ) =>
    system.mcpServer.create({
      data: {
        id: id(seeded, name),
        spaceId: seeded.spaces[spaceIndex],
        userId,
        slug: name,
        name: `Server ${name}`,
        transport: "stdio",
        command: "run",
        createdAt: OLD,
        updatedAt: OLD,
        ...extra,
      },
    });

  /** A sealed credential row of the given material; returns the secret row's id. */
  const secret = async (
    seeded: Seeded,
    name: string,
    material: string,
    extra: Record<string, unknown> = {},
  ) => {
    const secretId = id(seeded, name);
    return system.secret.create({
      data: {
        id: secretId,
        userId: seeded.userId,
        spaceId: seeded.spaces[0],
        kind: "mcp",
        ciphertext: await seal(secretId, material),
        ...extra,
      },
    });
  };

  const serverWithMaterial = async (
    seeded: Seeded,
    name: string,
    material: string,
    extra: Record<string, unknown> = {},
    secretExtra: Record<string, unknown> = {},
  ) => {
    const row = await secret(seeded, `${name}cred`, material, secretExtra);
    return server(seeded, name, { secretId: row.id, ...extra });
  };

  const assignment = (
    seeded: Seeded,
    name: string,
    botName: string,
    serverName: string,
    extra: Record<string, unknown> = {},
  ) =>
    system.botMcpServer.create({
      data: {
        id: id(seeded, name),
        spaceId: seeded.spaces[0],
        userId: seeded.userId,
        botId: id(seeded, botName),
        serverId: id(seeded, serverName),
        createdAt: OLD,
        updatedAt: OLD,
        ...extra,
      },
    });

  const card = (
    seeded: Seeded,
    name: string,
    threadName: string,
    serverName: string,
    status: string,
    seq: number,
    botName?: string,
  ) =>
    system.message.create({
      data: {
        id: id(seeded, name),
        threadId: id(seeded, threadName),
        botId: botName ? id(seeded, botName) : null,
        role: "bot",
        seq,
        blocks: [
          {
            kind: "mcp_approval",
            name: "Server",
            serverId: id(seeded, serverName),
            transport: "stdio",
            endpoint: null,
            needsOAuth: false,
            status,
          },
        ],
        createdAt: OLD,
      },
    });

  const session = (
    seeded: Seeded,
    name: string,
    serverName: string,
    extra: Record<string, unknown> = {},
  ) =>
    system.mcpOAuthSession.create({
      data: {
        id: id(seeded, name),
        spaceId: seeded.spaces[0],
        userId: seeded.userId,
        serverId: id(seeded, serverName),
        endpoint: "https://mcp.example.test/sse",
        redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
        oauthCiphertext: "sealed",
        createdAt: OLD,
        ...extra,
      },
    });

  const share = (seeded: Seeded, serverName: string, spaceIndex: 1 | 2 = 1) =>
    system.mcpServerSpace.create({
      data: {
        serverId: id(seeded, serverName),
        spaceId: seeded.spaces[spaceIndex],
        userId: seeded.userId,
      },
    });

  const otherUser = (seeded: Seeded) =>
    system.user.create({
      data: {
        id: `${seeded.userId}-other`,
        name: "Other Member",
        email: `${seeded.userId}-other@example.test`,
        emailVerified: true,
      },
    });

  const dismiss = (
    name: string,
    input: unknown,
    seed: (seeded: Seeded) => Promise<void>,
    extra: Partial<Case> = {},
  ): Case => ({
    name: `k-dismiss-${name}`,
    procedure: "mcp.assignments.dismiss",
    input,
    seed,
    ...extra,
  });

  const replace = (
    name: string,
    input: unknown,
    seed: (seeded: Seeded) => Promise<void>,
    extra: Partial<Case> = {},
  ): Case => ({
    name: `k-replace-${name}`,
    procedure: "mcp.assignments.replace",
    input,
    seed,
    ...extra,
  });

  const agents = (
    name: string,
    input: unknown,
    seed: (seeded: Seeded) => Promise<void>,
    extra: Partial<Case> = {},
  ): Case => ({
    name: `k-agents-${name}`,
    procedure: "mcp.servers.agents",
    input,
    seed,
    ...extra,
  });

  const remove = (
    name: string,
    input: unknown,
    seed: (seeded: Seeded) => Promise<void>,
    extra: Partial<Case> = {},
  ): Case => ({
    name: `k-remove-${name}`,
    procedure: "mcp.servers.remove",
    input,
    seed,
    ...extra,
  });

  const disconnect = (
    name: string,
    input: unknown,
    seed: (seeded: Seeded) => Promise<void>,
    extra: Partial<Case> = {},
  ): Case => ({
    name: `k-disconnect-${name}`,
    procedure: "mcp.oauth.disconnect",
    input,
    seed,
    ...extra,
  });

  // Shared seed shorthands.
  const botThreadServer = async (seeded: Seeded) => {
    await bot(seeded, "kb1");
    await thread(seeded, "kt1", "kb1");
    await server(seeded, "ks1");
  };
  const msg = (
    seeded: Seeded,
    name: string,
    threadName: string,
    serverName: string,
    status: string,
    seq: number,
  ) => card(seeded, name, threadName, serverName, status, seq, "kb1");

  return [
    // mcp.assignments.dismiss: the settings surface resolves every card except a connected one,
    // a chat decision resolves open cards only, and a lost card race is not an assignment.
    dismiss("settings", { botId: "__s-kb1__", serverId: "__s-ks1__" }, async (seeded) => {
      await bot(seeded, "kb1");
      await thread(seeded, "kt1", "kb1");
      await server(seeded, "ks1");
      await msg(seeded, "km1", "kt1", "ks1", "pending", 1);
      await msg(seeded, "km2", "kt1", "ks1", "connected", 2);
    }),
    dismiss(
      "chat-open",
      { botId: "__s-kb1__", serverId: "__s-ks1__", threadId: "__s-kt1__" },
      async (seeded) => {
        await botThreadServer(seeded);
        await msg(seeded, "km1", "kt1", "ks1", "pending", 1);
      },
    ),
    dismiss(
      "chat-already-dismissed",
      { botId: "__s-kb1__", serverId: "__s-ks1__", threadId: "__s-kt1__" },
      async (seeded) => {
        await botThreadServer(seeded);
        await msg(seeded, "km1", "kt1", "ks1", "dismissed", 1);
      },
    ),
    dismiss(
      "chat-connected",
      { botId: "__s-kb1__", serverId: "__s-ks1__", threadId: "__s-kt1__" },
      async (seeded) => {
        await botThreadServer(seeded);
        await msg(seeded, "km1", "kt1", "ks1", "connected", 1);
      },
    ),
    dismiss(
      "settings-repaints-dismissed",
      { botId: "__s-kb1__", serverId: "__s-ks1__" },
      async (seeded) => {
        await botThreadServer(seeded);
        await msg(seeded, "km1", "kt1", "ks1", "dismissed", 1);
        await msg(seeded, "km2", "kt1", "ks1", "pending", 2);
      },
    ),
    dismiss(
      "group-card",
      { botId: "__s-kb1__", serverId: "__s-ks1__", threadId: "__s-kg1__" },
      async (seeded) => {
        await bot(seeded, "kb1");
        await server(seeded, "ks1");
        await group(seeded, "kgrp", ["kb1"]);
        await groupThread(seeded, "kg1", "kgrp");
        await card(seeded, "km1", "kg1", "ks1", "pending", 1, "kb1");
      },
    ),
    dismiss(
      "group-bot-removed",
      { botId: "__s-kb1__", serverId: "__s-ks1__", threadId: "__s-kg1__" },
      async (seeded) => {
        await bot(seeded, "kb1");
        await thread(seeded, "kt1", "kb1");
        await server(seeded, "ks1");
        await group(seeded, "kgrp", []);
        await groupThread(seeded, "kg1", "kgrp");
        await card(seeded, "km1", "kg1", "ks1", "pending", 1, "kb1");
      },
    ),
    dismiss("unknown-server", { botId: "__s-kb1__", serverId: "missing" }, async (seeded) => {
      await bot(seeded, "kb1");
      await thread(seeded, "kt1", "kb1");
    }),
    dismiss("unknown-bot", { botId: "missing", serverId: "__s-ks1__" }, async (seeded) => {
      await server(seeded, "ks1");
    }),
    dismiss(
      "other-bot-thread",
      { botId: "__s-kb1__", serverId: "__s-ks1__", threadId: "__s-kt2__" },
      async (seeded) => {
        await bot(seeded, "kb1");
        await bot(seeded, "kb2");
        await thread(seeded, "kt1", "kb1");
        await thread(seeded, "kt2", "kb2");
        await server(seeded, "ks1");
        await msg(seeded, "km1", "kt2", "ks1", "pending", 1);
      },
    ),
    dismiss(
      "other-space-thread",
      { botId: "__s-kb1__", serverId: "__s-ks1__", threadId: "__s-kt2__" },
      async (seeded) => {
        await bot(seeded, "kb1");
        await bot(seeded, "kb2", 1);
        await thread(seeded, "kt1", "kb1");
        await thread(seeded, "kt2", "kb2", 1);
        await server(seeded, "ks1");
        await msg(seeded, "km1", "kt2", "ks1", "pending", 1);
      },
    ),
    dismiss("guest-member", { botId: "__s-kb1__", serverId: "__s-ks1__" }, async (seeded) => {
      await botThreadServer(seeded);
      await msg(seeded, "km1", "kt1", "ks1", "pending", 1);
      await system.spaceMember.update({
        where: { id: `${seeded.spaces[0]}-m` },
        data: { role: "guest" },
      });
    }),
    dismiss(
      "concurrent",
      { botId: "__s-kb1__", serverId: "__s-ks1__", threadId: "__s-kt1__" },
      async (seeded) => {
        await botThreadServer(seeded);
        await msg(seeded, "km1", "kt1", "ks1", "pending", 1);
      },
      { concurrent: 2 },
    ),
    dismiss("empty-bot", { botId: "", serverId: "__s-ks1__" }, async (seeded) => {
      await botThreadServer(seeded);
    }),
    dismiss("missing-server", { botId: "__s-kb1__" }, async (seeded) => {
      await botThreadServer(seeded);
    }),
    dismiss(
      "thread-null",
      { botId: "__s-kb1__", serverId: "__s-ks1__", threadId: null },
      async (seeded) => {
        await botThreadServer(seeded);
      },
    ),
    dismiss(
      "thread-number",
      { botId: "__s-kb1__", serverId: "__s-ks1__", threadId: 5 },
      async (seeded) => {
        await botThreadServer(seeded);
      },
    ),
    dismiss("no-input", undefined, async () => {}),
    dismiss("null-input", null, async () => {}),
    dismiss(
      "extra-keys",
      { botId: "__s-kb1__", serverId: "__s-ks1__", more: 1 },
      async (seeded) => {
        await botThreadServer(seeded);
      },
    ),
    dismiss(
      "anonymous",
      { botId: "__s-kb1__", serverId: "__s-ks1__" },
      async (seeded) => {
        await botThreadServer(seeded);
      },
      { anonymous: true },
    ),

    // mcp.assignments.replace: the list becomes exactly the input, removals revert connected
    // cards, and a repeated server is refused before any write.
    replace(
      "empty-to-two",
      {
        botId: "__s-kb1__",
        assignments: [
          { serverId: "__s-ks1__", allowedTools: ["read"] },
          { serverId: "__s-ks2__", allowAllTools: false, allowedTools: ["search", "open"] },
        ],
      },
      async (seeded) => {
        await bot(seeded, "kb1");
        await server(seeded, "ks1");
        await server(seeded, "ks2");
      },
    ),
    replace(
      "replace-existing",
      {
        botId: "__s-kb1__",
        assignments: [{ serverId: "__s-ks2__", allowAllTools: false, allowedTools: ["read"] }],
      },
      async (seeded) => {
        await bot(seeded, "kb1");
        await server(seeded, "ks1");
        await server(seeded, "ks2");
        await assignment(seeded, "ka1", "kb1", "ks1");
        await assignment(seeded, "ka2", "kb1", "ks2");
      },
    ),
    replace(
      "idempotent",
      {
        botId: "__s-kb1__",
        assignments: [{ serverId: "__s-ks1__", allowAllTools: true, allowedTools: ["read"] }],
      },
      async (seeded) => {
        await bot(seeded, "kb1");
        await server(seeded, "ks1");
        await assignment(seeded, "ka1", "kb1", "ks1", { allowedTools: ["read"] });
      },
    ),
    replace("clear-all", { botId: "__s-kb1__", assignments: [] }, async (seeded) => {
      await bot(seeded, "kb1");
      await server(seeded, "ks1");
      await assignment(seeded, "ka1", "kb1", "ks1");
    }),
    replace(
      "duplicate-server",
      {
        botId: "__s-kb1__",
        assignments: [{ serverId: "__s-ks1__" }, { serverId: "__s-ks1__" }],
      },
      async (seeded) => {
        await bot(seeded, "kb1");
        await server(seeded, "ks1");
        await assignment(seeded, "ka1", "kb1", "ks1");
      },
    ),
    replace(
      "unknown-server",
      { botId: "__s-kb1__", assignments: [{ serverId: "missing" }] },
      async (seeded) => {
        await bot(seeded, "kb1");
        await server(seeded, "ks1");
        await assignment(seeded, "ka1", "kb1", "ks1");
      },
    ),
    replace(
      "other-space-server",
      { botId: "__s-kb1__", assignments: [{ serverId: "__s-ks2__" }] },
      async (seeded) => {
        await bot(seeded, "kb1");
        await server(seeded, "ks2", {}, 1);
      },
    ),
    replace("bot-other-space", { botId: "__s-kb2__", assignments: [] }, async (seeded) => {
      await bot(seeded, "kb2", 1);
      await server(seeded, "ks1");
    }),
    replace("bot-unknown", { botId: "missing", assignments: [] }, async (seeded) => {
      await server(seeded, "ks1");
    }),
    replace(
      "removal-reverts-connected",
      { botId: "__s-kb1__", assignments: [] },
      async (seeded) => {
        await botThreadServer(seeded);
        await assignment(seeded, "ka1", "kb1", "ks1");
        await msg(seeded, "km1", "kt1", "ks1", "connected", 1);
      },
    ),
    replace("removal-keeps-open-card", { botId: "__s-kb1__", assignments: [] }, async (seeded) => {
      await botThreadServer(seeded);
      await assignment(seeded, "ka1", "kb1", "ks1");
      await msg(seeded, "km1", "kt1", "ks1", "pending", 1);
    }),
    replace(
      "tool-empty",
      { botId: "__s-kb1__", assignments: [{ serverId: "__s-ks1__", allowedTools: [""] }] },
      async (seeded) => {
        await bot(seeded, "kb1");
        await server(seeded, "ks1");
      },
    ),
    replace(
      "allow-null",
      { botId: "__s-kb1__", assignments: [{ serverId: "__s-ks1__", allowAllTools: null }] },
      async (seeded) => {
        await bot(seeded, "kb1");
        await server(seeded, "ks1");
      },
    ),
    replace(
      "tool-too-long",
      {
        botId: "__s-kb1__",
        assignments: [{ serverId: "__s-ks1__", allowedTools: ["x".repeat(201)] }],
      },
      async (seeded) => {
        await bot(seeded, "kb1");
        await server(seeded, "ks1");
      },
    ),
    replace("assignments-missing", { botId: "__s-kb1__" }, async (seeded) => {
      await bot(seeded, "kb1");
    }),
    replace("item-not-object", { botId: "__s-kb1__", assignments: [5] }, async (seeded) => {
      await bot(seeded, "kb1");
    }),
    replace(
      "extra-keys",
      {
        botId: "__s-kb1__",
        extra: true,
        assignments: [{ serverId: "__s-ks1__", more: 1 }],
      },
      async (seeded) => {
        await bot(seeded, "kb1");
        await server(seeded, "ks1");
      },
    ),
    replace("empty-bot", { botId: "", assignments: [] }, async (seeded) => {
      await bot(seeded, "kb1");
    }),
    replace(
      "anonymous",
      { botId: "__s-kb1__", assignments: [] },
      async (seeded) => {
        await bot(seeded, "kb1");
      },
      { anonymous: true },
    ),

    // mcp.servers.agents: allBots keeps assignments, choosing agents replaces them, and a
    // removed bot's connected cards go back to pending.
    agents("all-bots", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await bot(seeded, "kb1");
      await server(seeded, "ks1");
      await assignment(seeded, "ka1", "kb1", "ks1");
    }),
    agents(
      "choose-two",
      { id: "__s-ks1__", allBots: false, botIds: ["__s-kb1__", "__s-kb2__"] },
      async (seeded) => {
        await bot(seeded, "kb1");
        await bot(seeded, "kb2");
        await server(seeded, "ks1");
      },
    ),
    agents(
      "dedupe",
      { id: "__s-ks1__", allBots: false, botIds: ["__s-kb1__", "__s-kb1__"] },
      async (seeded) => {
        await bot(seeded, "kb1");
        await server(seeded, "ks1");
      },
    ),
    agents("choose-none", { id: "__s-ks1__", allBots: false, botIds: [] }, async (seeded) => {
      await bot(seeded, "kb1");
      await bot(seeded, "kb2");
      await server(seeded, "ks1");
      await assignment(seeded, "ka1", "kb1", "ks1");
      await assignment(seeded, "ka2", "kb2", "ks1");
    }),
    agents(
      "remove-reverts-card",
      { id: "__s-ks1__", allBots: false, botIds: ["__s-kb2__"] },
      async (seeded) => {
        await bot(seeded, "kb1");
        await bot(seeded, "kb2");
        await thread(seeded, "kt1", "kb1");
        await server(seeded, "ks1");
        await assignment(seeded, "ka1", "kb1", "ks1");
        await msg(seeded, "km1", "kt1", "ks1", "connected", 1);
      },
    ),
    agents(
      "archived-bot",
      { id: "__s-ks1__", allBots: false, botIds: ["__s-kb1__"] },
      async (seeded) => {
        await bot(seeded, "kb1", 0, { archivedAt: OLD });
        await server(seeded, "ks1");
      },
    ),
    agents(
      "unknown-bot",
      { id: "__s-ks1__", allBots: false, botIds: ["missing"] },
      async (seeded) => {
        await server(seeded, "ks1", { allBots: true });
      },
    ),
    agents(
      "other-space-bot",
      { id: "__s-ks1__", allBots: false, botIds: ["__s-kb2__"] },
      async (seeded) => {
        await bot(seeded, "kb2", 1);
        await server(seeded, "ks1");
      },
    ),
    agents("unknown-server", { id: "missing", allBots: true }, async (seeded) => {
      await bot(seeded, "kb1");
    }),
    agents("other-space-server", { id: "__s-ks2__", allBots: true }, async (seeded) => {
      await server(seeded, "ks2", {}, 1);
    }),
    agents(
      "shared-server",
      { id: "__s-ks1__", allBots: false, botIds: ["__s-kb1__"] },
      async (seeded) => {
        await bot(seeded, "kb1");
        await server(seeded, "ks1");
        await share(seeded, "ks1", 1);
      },
    ),
    agents("oauth-connected", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await serverWithMaterial(
        seeded,
        "ks1",
        JSON.stringify({
          oauth: { tokens: { access_token: "a" } },
          oauthClient: { client_id: "c1" },
        }),
      );
    }),
    // JSON.parse yields ±Infinity for an overflowing literal; Boolean(Infinity) is true, so
    // hasSecret must follow TS rather than treating Float64's ErrRange as false.
    agents("material-length-overflow", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await serverWithMaterial(seeded, "ks1", `{"args":{"length":1e999}}`);
    }),
    agents(
      "material-length-negative-overflow",
      { id: "__s-ks1__", allBots: true },
      async (seeded) => {
        await serverWithMaterial(seeded, "ks1", `{"args":{"length":-1e999}}`);
      },
    ),
    agents("material-length-zero-overflow", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await serverWithMaterial(seeded, "ks1", `{"args":{"length":0e999}}`);
    }),
    agents("bot-ids-missing", { id: "__s-ks1__", allBots: false }, async (seeded) => {
      await bot(seeded, "kb1");
      await server(seeded, "ks1");
      await assignment(seeded, "ka1", "kb1", "ks1");
    }),
    agents("bot-ids-null", { id: "__s-ks1__", allBots: false, botIds: null }, async (seeded) => {
      await server(seeded, "ks1");
    }),
    agents("all-bots-missing", { id: "__s-ks1__" }, async (seeded) => {
      await server(seeded, "ks1");
    }),
    agents("empty-id", { id: "", allBots: true }, async (seeded) => {
      await server(seeded, "ks1");
    }),
    agents(
      "anonymous",
      { id: "__s-ks1__", allBots: true },
      async (seeded) => {
        await server(seeded, "ks1");
      },
      { anonymous: true },
    ),

    // mcp.servers.remove: the row, its assignments, its sessions, its credential and every card
    // that names it go; a card already dismissed is left alone.
    remove("plain", { id: "__s-ks1__" }, async (seeded) => {
      await server(seeded, "ks1");
    }),
    remove("with-material", { id: "__s-ks1__" }, async (seeded) => {
      await serverWithMaterial(seeded, "ks1", JSON.stringify({ secret: "s3cr3t" }));
    }),
    remove("with-cards", { id: "__s-ks1__" }, async (seeded) => {
      await bot(seeded, "kb1");
      await bot(seeded, "kb2");
      await thread(seeded, "kt1", "kb1");
      await thread(seeded, "kt2", "kb2");
      await server(seeded, "ks1");
      await msg(seeded, "km1", "kt1", "ks1", "pending", 1);
      await msg(seeded, "km2", "kt1", "ks1", "connected", 2);
      await msg(seeded, "km3", "kt2", "ks1", "dismissed", 1);
      await msg(seeded, "km4", "kt2", "ks1", "pending", 2);
    }),
    remove("material-missing", { id: "__s-ks1__" }, async (seeded) => {
      // A credential row the caller cannot read stands in for a vanished one: the FK forbids
      // pointing at an id that never existed.
      await otherUser(seeded);
      await secret(seeded, "kgone", JSON.stringify({ secret: "s3cr3t" }), {
        userId: `${seeded.userId}-other`,
      });
      await server(seeded, "ks1", { secretId: id(seeded, "kgone") });
    }),
    remove("sessions-cascade", { id: "__s-ks1__" }, async (seeded) => {
      await bot(seeded, "kb1");
      await server(seeded, "ks1");
      await assignment(seeded, "ka1", "kb1", "ks1");
      await session(seeded, "kses1", "ks1");
    }),
    remove(
      "all-spaces-from-other",
      { id: "__s-ks1__" },
      async (seeded) => {
        await server(seeded, "ks1", { allSpaces: true });
      },
      { space: 1 },
    ),
    remove("unknown", { id: "missing" }, async (seeded) => {
      await server(seeded, "ks1");
    }),
    remove("other-space-server", { id: "__s-ks2__" }, async (seeded) => {
      await server(seeded, "ks2", {}, 1);
    }),
    remove("other-user-server", { id: "__s-ks2__" }, async (seeded) => {
      await otherUser(seeded);
      await server(seeded, "ks2", {}, 0, `${seeded.userId}-other`);
    }),
    remove("empty-id", { id: "" }, async (seeded) => {
      await server(seeded, "ks1");
    }),
    remove("null-input", null, async () => {}),
    remove(
      "anonymous",
      { id: "__s-ks1__" },
      async (seeded) => {
        await server(seeded, "ks1");
      },
      { anonymous: true },
    ),

    // mcp.oauth.disconnect: the stored grant goes, its generation rises, the revision bumps and
    // the old health verdict resets. The material JSON must match JSON.stringify byte for byte.
    disconnect("plain", { serverId: "__s-ks1__" }, async (seeded) => {
      await server(seeded, "ks1");
    }),
    disconnect("with-grant", { serverId: "__s-ks1__" }, async (seeded) => {
      await serverWithMaterial(
        seeded,
        "ks1",
        JSON.stringify({
          oauth: { tokens: { access_token: "a", token_type: "Bearer" }, obtainedAt: 5 },
          oauthGeneration: 2,
          secret: "abc",
        }),
      );
    }),
    disconnect("without-grant", { serverId: "__s-ks1__" }, async (seeded) => {
      await serverWithMaterial(
        seeded,
        "ks1",
        JSON.stringify({
          oauth: { clientInformation: { client_id: "c" } },
          oauthClient: { client_id: "c" },
        }),
      );
    }),
    disconnect("key-order", { serverId: "__s-ks1__" }, async (seeded) => {
      await serverWithMaterial(
        seeded,
        "ks1",
        `{"oauth":{"tokens":{"access_token":"t"}},"zeta":1,"secret":"s","oauthGeneration":2}`,
      );
    }),
    disconnect("generation-appended", { serverId: "__s-ks1__" }, async (seeded) => {
      await serverWithMaterial(seeded, "ks1", `{"zeta":1,"secret":"s","oauth":{"tokens":{}}}`);
    }),
    disconnect("invalid-material", { serverId: "__s-ks1__" }, async (seeded) => {
      await serverWithMaterial(seeded, "ks1", "not json");
    }),
    disconnect("null-material", { serverId: "__s-ks1__" }, async (seeded) => {
      await serverWithMaterial(seeded, "ks1", "null");
    }),
    disconnect("string-generation", { serverId: "__s-ks1__" }, async (seeded) => {
      await serverWithMaterial(seeded, "ks1", `{"secret":"s","oauthGeneration":"x"}`);
    }),
    disconnect("sessions", { serverId: "__s-ks1__" }, async (seeded) => {
      await server(seeded, "ks1", { allSpaces: true });
      await session(seeded, "kses1", "ks1");
      await session(seeded, "kses2", "ks1", { spaceId: seeded.spaces[1] });
    }),
    disconnect("other-space-server-deletes-sessions", { serverId: "__s-ks2__" }, async (seeded) => {
      await server(seeded, "ks2", {}, 1);
      await session(seeded, "kses1", "ks2");
    }),
    disconnect(
      "all-spaces-from-other",
      { serverId: "__s-ks1__" },
      async (seeded) => {
        await serverWithMaterial(seeded, "ks1", `{"secret":"s"}`, { allSpaces: true });
      },
      { space: 1 },
    ),
    disconnect("shared-material-null-space", { serverId: "__s-ks1__" }, async (seeded) => {
      await serverWithMaterial(seeded, "ks1", `{"secret":"s"}`);
      await share(seeded, "ks1", 1);
    }),
    disconnect("unknown-server", { serverId: "missing" }, async (seeded) => {
      await bot(seeded, "kb1");
    }),
    disconnect("empty-server", { serverId: "" }, async (seeded) => {
      await server(seeded, "ks1");
    }),
    disconnect("missing-server", {}, async (seeded) => {
      await server(seeded, "ks1");
    }),
    disconnect("null-input", null, async () => {}),
    disconnect(
      "anonymous",
      { serverId: "__s-ks1__" },
      async (seeded) => {
        await server(seeded, "ks1");
      },
      { anonymous: true },
    ),
  ];
}

/**
 * The MCP rows the lane's procedures change: the server's revision and health, the assignments,
 * and the pending OAuth session rows. Servers and sessions are ordered by their fixed ids; the
 * assignments are ordered by what they mean, because a created row's id is random on each side.
 */
export async function laneKState(system: System, seeded: Seeded, procedure?: string) {
  if (!procedure?.startsWith("mcp.")) return {};
  const owners = { in: [seeded.userId, `${seeded.userId}-other`] };
  const servers = await system.mcpServer.findMany({
    where: { userId: owners },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      secretId: true,
      allBots: true,
      revision: true,
      healthStatus: true,
      healthMessage: true,
      healthToolCount: true,
      healthCheckedAt: true,
      updatedAt: true,
    },
    orderBy: { id: "asc" },
  });
  const assignments = await system.botMcpServer.findMany({
    where: { spaceId: { in: seeded.spaces } },
    select: {
      spaceId: true,
      userId: true,
      botId: true,
      serverId: true,
      allowAllTools: true,
      allowedTools: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  const stable = (row: any) => JSON.stringify(row);
  assignments.sort((left: any, right: any) => stable(left).localeCompare(stable(right)));
  const sessions = await system.mcpOAuthSession.findMany({
    where: { spaceId: { in: seeded.spaces } },
    select: { id: true, spaceId: true, userId: true, serverId: true, createdAt: true },
    orderBy: { id: "asc" },
  });
  return { laneK: { servers, assignments, sessions } };
}
