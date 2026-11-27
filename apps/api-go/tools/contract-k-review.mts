/**
 * Independent review cases for Lane K (MCP completion): mcp.assignments.dismiss,
 * mcp.assignments.replace, mcp.servers.agents, mcp.servers.remove and mcp.oauth.disconnect.
 *
 * Case names and seeded ids must not contain the TypeScript redactor's words (secret,
 * token, credential, email, ...): the gateway's safety gate refuses such audit metadata,
 * and a case name that trips it tests the gate, not the procedure.
 *
 * These go beyond the implementer's 86: output-schema rows the API can still read (the router
 * must answer 500 "Output validation failed" on both sides), foreign owners, cards behind a
 * repaint filter, shared credentials, oversized and unicode inputs, live runs beside a removed
 * server, and concurrent disconnects.
 */
import assert from "node:assert/strict";
import { EncryptedSecretStore } from "../../../packages/adapters/src/secrets/secrets.js";
import type { Case, Seeded } from "./contract.mts";
import { CONTRACT_ENCRYPTION_KEY } from "./contract-key.mts";

type System = any;

const OLD = new Date(Date.UTC(2022, 4, 1));
// Cards and assignments are listed ordered by createdAt alone; rows that share a timestamp order
// arbitrarily. One millisecond per seeded row, keyed by the seed object, keeps the order total and
// identical on both sides (the harness seeds each side with a fresh object).
const seedTimes = new WeakMap<Seeded, number>();
const seedTime = (seeded: Seeded) => {
  const n = seedTimes.get(seeded) ?? 0;
  seedTimes.set(seeded, n + 1);
  return new Date(OLD.getTime() + n);
};
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

export function laneKReviewCases(system: System): Case[] {
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

  const otherUser = (seeded: Seeded) =>
    system.user.create({
      data: {
        id: `${seeded.userId}-other`,
        name: "Other Member",
        email: `${seeded.userId}-other@example.test`,
        emailVerified: true,
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

  const group = async (seeded: Seeded, name: string, botNames: string[], archived = false) => {
    await system.chatGroup.create({
      data: {
        id: id(seeded, name),
        spaceId: seeded.spaces[0],
        userId: seeded.userId,
        name,
        createdAt: OLD,
        updatedAt: OLD,
        ...(archived ? { archivedAt: OLD } : {}),
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
        createdAt: seedTime(seeded),
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
        role: botName ? "bot" : "user",
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
        createdAt: seedTime(seeded),
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

  const agents = (name: string, input: unknown, seed: (seeded: Seeded) => Promise<void>, extra: Partial<Case> = {}): Case => ({
    name: `krev-agents-${name}`,
    procedure: "mcp.servers.agents",
    input,
    seed,
    ...extra,
  });
  const replace = (name: string, input: unknown, seed: (seeded: Seeded) => Promise<void>, extra: Partial<Case> = {}): Case => ({
    name: `krev-replace-${name}`,
    procedure: "mcp.assignments.replace",
    input,
    seed,
    ...extra,
  });
  const dismiss = (name: string, input: unknown, seed: (seeded: Seeded) => Promise<void>, extra: Partial<Case> = {}): Case => ({
    name: `krev-dismiss-${name}`,
    procedure: "mcp.assignments.dismiss",
    input,
    seed,
    ...extra,
  });
  const remove = (name: string, input: unknown, seed: (seeded: Seeded) => Promise<void>, extra: Partial<Case> = {}): Case => ({
    name: `krev-remove-${name}`,
    procedure: "mcp.servers.remove",
    input,
    seed,
    ...extra,
  });
  const disconnect = (name: string, input: unknown, seed: (seeded: Seeded) => Promise<void>, extra: Partial<Case> = {}): Case => ({
    name: `krev-disconnect-${name}`,
    procedure: "mcp.oauth.disconnect",
    input,
    seed,
    ...extra,
  });

  const emptyTools = (count: number, value: string) => Array.from({ length: count }, () => value);

  return [
    // ---- output schema: a stored row the API can still read must fail validation on both sides
    agents("endpoint-padded", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await server(seeded, "ks1", { transport: "sse", endpoint: " http://example.test " });
    }),
    agents("endpoint-urn", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await server(seeded, "ks1", { transport: "sse", endpoint: "urn:foo:bar" });
    }),
    agents("endpoint-mailto", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await server(seeded, "ks1", { transport: "sse", endpoint: "mailto:x@y" });
    }),
    agents("endpoint-file", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await server(seeded, "ks1", { transport: "sse", endpoint: "file:///tmp/a" });
    }),
    agents("endpoint-bad-port", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await server(seeded, "ks1", { transport: "sse", endpoint: "http://x:99999/" });
    }),
    agents("empty-assignment-id", { id: "__s-ks1__", allBots: false, botIds: ["__s-kb1__"] }, async (seeded) => {
      await bot(seeded, "kb1");
      await server(seeded, "ks1");
      await system.botMcpServer.create({
        data: {
          id: "",
          spaceId: seeded.spaces[0],
          userId: seeded.userId,
          botId: id(seeded, "kb1"),
          serverId: id(seeded, "ks1"),
          createdAt: OLD,
          updatedAt: OLD,
        },
      });
    }),
    agents("tool-200-astral", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await server(seeded, "ks1");
      await bot(seeded, "kb1");
      await assignment(seeded, "ka1", "kb1", "ks1", { allowedTools: emptyTools(1, "😀".repeat(200)) });
    }),
    agents("tool-201-astral", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await server(seeded, "ks1");
      await bot(seeded, "kb1");
      await assignment(seeded, "ka1", "kb1", "ks1", { allowedTools: emptyTools(1, "😀".repeat(201)) });
    }),
    agents("tool-empty-string", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await server(seeded, "ks1");
      await bot(seeded, "kb1");
      await assignment(seeded, "ka1", "kb1", "ks1", { allowedTools: [""] });
    }),
    agents("health-negative", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await server(seeded, "ks1", { healthToolCount: -1 });
    }),
    agents("install-empty", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await system.capabilityInstall.create({
        data: {
          id: "",
          spaceId: seeded.spaces[0],
          userId: seeded.userId,
          kind: "plugin",
          name: "Empty install",
          source: "test",
          config: {},
        },
      });
      await server(seeded, "ks1", { installId: "" });
    }),
    agents("revision-zero", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await server(seeded, "ks1", { revision: 0 });
    }),
    agents("transport-weird", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await server(seeded, "ks1", { transport: "weird" });
    }),
    agents("oauth-client-number", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await serverWithMaterial(seeded, "ks1", `{"oauthClient":{"client_id":5}}`);
    }),
    agents("material-length-string", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await serverWithMaterial(seeded, "ks1", `{"args":{"length":"x"}}`);
    }),
    agents("oauth-truthy-primitive", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await serverWithMaterial(seeded, "ks1", `{"oauth":true}`);
    }),

    // ---- foreign owners and archived bots
    agents("other-user-bot", { id: "__s-ks1__", allBots: false, botIds: ["__s-kb2__"] }, async (seeded) => {
      await otherUser(seeded);
      await bot(seeded, "kb2", 0, { userId: `${seeded.userId}-other` });
      await server(seeded, "ks1");
    }),
    agents("shared-other-owner", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await otherUser(seeded);
      await server(seeded, "ks1", {}, 0, `${seeded.userId}-other`);
      await system.mcpServerSpace.create({
        data: {
          serverId: id(seeded, "ks1"),
          spaceId: seeded.spaces[0],
          userId: `${seeded.userId}-other`,
        },
      });
    }),
    agents("500-duplicate-bots", {
      id: "__s-ks1__",
      allBots: false,
      botIds: Array.from({ length: 500 }, () => "__s-kb1__"),
    }, async (seeded) => {
      await bot(seeded, "kb1");
      await server(seeded, "ks1");
    }),
    agents("501-duplicate-bots", {
      id: "__s-ks1__",
      allBots: false,
      botIds: Array.from({ length: 501 }, () => "__s-kb1__"),
    }, async (seeded) => {
      await bot(seeded, "kb1");
      await server(seeded, "ks1");
    }),
    agents("foreign-assignment", { id: "__s-ks1__", allBots: false, botIds: ["__s-kb1__"] }, async (seeded) => {
      await otherUser(seeded);
      await bot(seeded, "kb1");
      await server(seeded, "ks1");
      await system.botMcpServer.create({
        data: {
          id: id(seeded, "ka1"),
          spaceId: seeded.spaces[0],
          userId: `${seeded.userId}-other`,
          botId: id(seeded, "kb1"),
          serverId: id(seeded, "ks1"),
          createdAt: OLD,
          updatedAt: OLD,
        },
      });
    }),
    agents("two-bots-order", { id: "__s-ks1__", allBots: false, botIds: ["__s-kb2__", "__s-kb1__"] }, async (seeded) => {
      await bot(seeded, "kb1");
      await bot(seeded, "kb2");
      await server(seeded, "ks1");
    }),

    dismiss("shared-other-owner", { botId: "__s-kb1__", serverId: "__s-ks1__" }, async (seeded) => {
      await otherUser(seeded);
      await bot(seeded, "kb1");
      await thread(seeded, "kt1", "kb1");
      await server(seeded, "ks1", {}, 0, `${seeded.userId}-other`);
      await system.mcpServerSpace.create({
        data: {
          serverId: id(seeded, "ks1"),
          spaceId: seeded.spaces[0],
          userId: `${seeded.userId}-other`,
        },
      });
      await card(seeded, "km1", "kt1", "ks1", "pending", 1, "kb1");
    }),
    // The gate is deliberately over-conservative: TypeScript leaves "sk-live" unchanged (its
    // sk- rule needs 8+ following characters), but Go refuses any sk-/sk_/ak_/ck_/eyJ value.
    // The request declines to TypeScript, which serves it and writes the audit rows, so the
    // stored rows are TS's and nothing is dropped.
    dismiss("unredactable-metadata", { botId: "sk-live", serverId: "authorization" }, async (seeded) => {
      await bot(seeded, "kb1");
      await thread(seeded, "kt1", "kb1");
      await server(seeded, "ks1");
    }, { declines: true }),
    dismiss("archived-group-member", { botId: "__s-kb1__", serverId: "__s-ks1__", threadId: "__s-kg1__" }, async (seeded) => {
      await bot(seeded, "kb1");
      await thread(seeded, "kt1", "kb1");
      await server(seeded, "ks1");
      await group(seeded, "kgrp", ["kb1"], true);
      await groupThread(seeded, "kg1", "kgrp");
      await card(seeded, "km1", "kg1", "ks1", "pending", 1, "kb1");
    }),
    dismiss("group-bot-not-member", { botId: "__s-kb1__", serverId: "__s-ks1__", threadId: "__s-kg1__" }, async (seeded) => {
      await bot(seeded, "kb1");
      await thread(seeded, "kt1", "kb1");
      await server(seeded, "ks1");
      await group(seeded, "kgrp", [], true);
      await groupThread(seeded, "kg1", "kgrp");
      await card(seeded, "km1", "kg1", "ks1", "pending", 1, "kb1");
    }),

    replace("other-user-bot", { botId: "__s-kb2__", assignments: [{ serverId: "__s-ks1__" }] }, async (seeded) => {
      await otherUser(seeded);
      await bot(seeded, "kb2", 0, { userId: `${seeded.userId}-other` });
      await server(seeded, "ks1");
    }),
    replace("shared-from-space2", { botId: "__s-kb1__", assignments: [{ serverId: "__s-ks2__" }] }, async (seeded) => {
      await bot(seeded, "kb1", 1);
      await server(seeded, "ks2");
      await system.mcpServerSpace.create({
        data: {
          serverId: id(seeded, "ks2"),
          spaceId: seeded.spaces[1],
          userId: seeded.userId,
        },
      });
    }, { space: 1 }),
    agents("two-shares", { id: "__s-ks1__", allBots: true }, async (seeded) => {
      await server(seeded, "ks1");
      await share(seeded, "ks1", 1);
      await share(seeded, "ks1", 2);
    }, { space: 1 }),
    replace("tools-500", { botId: "__s-kb1__", assignments: [{ serverId: "__s-ks1__", allowedTools: emptyTools(500, "t") }] }, async (seeded) => {
      await bot(seeded, "kb1");
      await server(seeded, "ks1");
    }),
    replace("tools-501", { botId: "__s-kb1__", assignments: [{ serverId: "__s-ks1__", allowedTools: emptyTools(501, "t") }] }, async (seeded) => {
      await bot(seeded, "kb1");
      await server(seeded, "ks1");
    }),
    replace("tools-nonstring", { botId: "__s-kb1__", assignments: [{ serverId: "__s-ks1__", allowedTools: [1, true, null] }] }, async (seeded) => {
      await bot(seeded, "kb1");
      await server(seeded, "ks1");
    }),
    replace("lone-surrogate-tool", {
      botId: "__s-kb1__",
      assignments: [{ serverId: "__s-ks1__", allowedTools: ["\ud800"] }],
    }, async (seeded) => {
      await bot(seeded, "kb1");
      await server(seeded, "ks1");
    }),
    replace("lone-surrogate-server", {
      botId: "__s-kb1__",
      assignments: [{ serverId: "\ud800" }],
    }, async (seeded) => {
      await bot(seeded, "kb1");
      await server(seeded, "ks1");
    }),
    replace("duplicate-invisible", {
      botId: "__s-kb1__",
      assignments: [{ serverId: "__s-ks1__" }, { serverId: "__s-ks2__" }],
    }, async (seeded) => {
      await bot(seeded, "kb1");
      await server(seeded, "ks1");
      await server(seeded, "ks2", {}, 1);
      await assignment(seeded, "ka1", "kb1", "ks1");
    }),
    replace("foreign-assignment-conflict", { botId: "__s-kb1__", assignments: [{ serverId: "__s-ks1__" }] }, async (seeded) => {
      await otherUser(seeded);
      await bot(seeded, "kb1");
      await server(seeded, "ks1");
      await server(seeded, "ks2");
      await assignment(seeded, "ka2", "kb1", "ks2");
      await system.botMcpServer.create({
        data: {
          id: id(seeded, "ka1"),
          spaceId: seeded.spaces[0],
          userId: `${seeded.userId}-other`,
          botId: id(seeded, "kb1"),
          serverId: id(seeded, "ks1"),
          createdAt: OLD,
          updatedAt: OLD,
        },
      });
    }),
    replace("dismissed-card", { botId: "__s-kb1__", assignments: [] }, async (seeded) => {
      await bot(seeded, "kb1");
      await thread(seeded, "kt1", "kb1");
      await server(seeded, "ks1");
      await assignment(seeded, "ka1", "kb1", "ks1");
      await card(seeded, "km1", "kt1", "ks1", "dismissed", 1, "kb1");
    }),
    replace("connected-other-bot-message", { botId: "__s-kb1__", assignments: [] }, async (seeded) => {
      await bot(seeded, "kb1");
      await bot(seeded, "kb2");
      await thread(seeded, "kt1", "kb1");
      await server(seeded, "ks1");
      await assignment(seeded, "ka1", "kb1", "ks1");
      await card(seeded, "km1", "kt1", "ks1", "connected", 1, "kb2");
    }),
    replace("connected-user-message", { botId: "__s-kb1__", assignments: [] }, async (seeded) => {
      await bot(seeded, "kb1");
      await thread(seeded, "kt1", "kb1");
      await server(seeded, "ks1");
      await assignment(seeded, "ka1", "kb1", "ks1");
      await card(seeded, "km1", "kt1", "ks1", "connected", 1);
    }),
    replace("connected-group-written", { botId: "__s-kb1__", assignments: [] }, async (seeded) => {
      await bot(seeded, "kb1");
      await server(seeded, "ks1");
      await group(seeded, "kgrp", ["kb1"]);
      await groupThread(seeded, "kg1", "kgrp");
      await assignment(seeded, "ka1", "kb1", "ks1");
      await card(seeded, "km0", "kg1", "ks1", "pending", 1, "kb1");
      await card(seeded, "km1", "kg1", "ks1", "connected", 2, "kb1");
    }),

    // ---- removal beside live work, several bots, shared credentials, other Spaces
    remove("foreign-assignment", { id: "__s-ks1__" }, async (seeded) => {
      await otherUser(seeded);
      await bot(seeded, "kb1");
      await server(seeded, "ks1");
      await system.botMcpServer.create({
        data: {
          id: id(seeded, "ka1"),
          spaceId: seeded.spaces[0],
          userId: `${seeded.userId}-other`,
          botId: id(seeded, "kb1"),
          serverId: id(seeded, "ks1"),
          createdAt: OLD,
          updatedAt: OLD,
        },
      });
    }),
    remove("live-run", { id: "__s-ks1__" }, async (seeded) => {
      await bot(seeded, "kb1");
      await thread(seeded, "kt1", "kb1");
      await server(seeded, "ks1");
      await assignment(seeded, "ka1", "kb1", "ks1");
      await card(seeded, "km1", "kt1", "ks1", "connected", 1, "kb1");
      // Fresh, not OLD: the API's in-process sweeper cancels a queued run it finds stuck, and
      // that write would land on the TypeScript side only (Go runs no sweeper). A live run this
      // second is what "using the server" means here. The wake time is parked out of reach so
      // the run-wakeup scanner neither claims it nor publishes its `runs` frame into the window
      // (a queued run with a null `wakeAt` is due at once, run-wakeup.ts:412).
      const now = new Date();
      await system.task.create({
        data: {
          id: id(seeded, "ktask"),
          spaceId: seeded.spaces[0],
          botId: id(seeded, "kb1"),
          threadId: id(seeded, "kt1"),
          userId: seeded.userId,
          prompt: "use the server",
          status: "queued",
          createdAt: now,
          updatedAt: now,
        },
      });
      await system.run.create({
        data: {
          id: id(seeded, "krun"),
          spaceId: seeded.spaces[0],
          botId: id(seeded, "kb1"),
          threadId: id(seeded, "kt1"),
          taskId: id(seeded, "ktask"),
          userId: seeded.userId,
          status: "queued",
          trigger: "user",
          createdAt: now,
          updatedAt: now,
          wakeAt: new Date("2100-01-01T00:00:00.000Z"),
        },
      });
    }, {
      check: async ({ seeded, side }) => {
        const runs = await system.run.findMany({
          where: { id: id(seeded, "krun") },
          select: { id: true, status: true, threadId: true, botId: true, taskId: true, completedAt: true },
        });
        const tasks = await system.task.findMany({
          where: { id: id(seeded, "ktask") },
          select: { id: true, status: true, threadId: true, botId: true },
        });
        assert.deepEqual(runs, [{
          id: id(seeded, "krun"),
          status: "queued",
          threadId: id(seeded, "kt1"),
          botId: id(seeded, "kb1"),
          taskId: id(seeded, "ktask"),
          completedAt: null,
        }], `${side}: a live run changed during mcp.servers.remove`);
        assert.deepEqual(tasks, [{
          id: id(seeded, "ktask"),
          status: "queued",
          threadId: id(seeded, "kt1"),
          botId: id(seeded, "kb1"),
        }], `${side}: the queued task changed during mcp.servers.remove`);
      },
    }),
    remove("several-bots", { id: "__s-ks1__" }, async (seeded) => {
      await server(seeded, "ks1");
      for (const name of ["kb1", "kb2", "kb3"]) {
        await bot(seeded, name);
        await thread(seeded, `kt${name.slice(-1)}`, name);
        await assignment(seeded, `ka${name.slice(-1)}`, name, "ks1");
        await card(seeded, `km${name.slice(-1)}`, `kt${name.slice(-1)}`, "ks1", "connected", 1, name);
      }
    }),
    remove("shared-store", { id: "__s-ks1__" }, async (seeded) => {
      const row = await secret(seeded, "kshared", JSON.stringify({ secret: "s" }));
      await server(seeded, "ks1", { secretId: row.id });
      await server(seeded, "ks2", { secretId: row.id });
    }),
    remove("sessions-other-space", { id: "__s-ks1__" }, async (seeded) => {
      await server(seeded, "ks1");
      await session(seeded, "kses1", "ks1");
      await session(seeded, "kses2", "ks1", { spaceId: seeded.spaces[2] });
    }),
    remove("card-other-space", { id: "__s-ks1__" }, async (seeded) => {
      await bot(seeded, "kb1");
      await bot(seeded, "kb2", 1);
      await thread(seeded, "kt2", "kb2", 1);
      await server(seeded, "ks1");
      await card(seeded, "km1", "kt2", "ks1", "pending", 1, "kb2");
    }),
    remove("foreign-material", { id: "__s-ks1__" }, async (seeded) => {
      await otherUser(seeded);
      await secret(seeded, "kother", JSON.stringify({ secret: "s" }), {
        userId: `${seeded.userId}-other`,
      });
      await server(seeded, "ks1", { secretId: id(seeded, "kother") });
    }),

    // ---- disconnect material and ownership corners
    disconnect("keeps-material", { serverId: "__s-ks1__" }, async (seeded) => {
      await serverWithMaterial(seeded, "ks1", JSON.stringify({
        args: ["--x"], env: { A: "1" }, files: { f: "x" }, headers: { H: "v" }, secret: "s",
        oauth: { tokens: { access_token: "t" } }, oauthClient: { client_id: "c" }, oauthGeneration: 2,
      }));
    }),
    disconnect("corrupt-material", { serverId: "__s-ks1__" }, async (seeded) => {
      await system.secret.create({
        data: {
          id: id(seeded, "ks1cred"),
          userId: seeded.userId,
          spaceId: seeded.spaces[0],
          kind: "mcp",
          ciphertext: "not-a-sealed-value",
        },
      });
      await server(seeded, "ks1", { secretId: id(seeded, "ks1cred") });
    }),
    disconnect("unreadable-space-material", { serverId: "__s-ks1__" }, async (seeded) => {
      await serverWithMaterial(seeded, "ks1", `{"secret":"s"}`, { allSpaces: true }, { spaceId: seeded.spaces[2] });
    }, { space: 1 }),
    // Same decline as dismiss: "sk-live" is not a value the Go gate can prove byte-identical.
    disconnect("unredactable-metadata", { serverId: "sk-live" }, async (seeded) => {
      await server(seeded, "ks1");
    }, { declines: true }),
    disconnect("generation-float", { serverId: "__s-ks1__" }, async (seeded) => {
      await serverWithMaterial(seeded, "ks1", `{"secret":"s","oauthGeneration":1.5}`);
    }),
    disconnect("generation-object", { serverId: "__s-ks1__" }, async (seeded) => {
      await serverWithMaterial(seeded, "ks1", `{"secret":"s","oauthGeneration":{"a":1}}`);
    }),
    disconnect("material-array", { serverId: "__s-ks1__" }, async (seeded) => {
      await serverWithMaterial(seeded, "ks1", `[1,2]`);
    }),
    disconnect("no-oauth-key", { serverId: "__s-ks1__" }, async (seeded) => {
      await serverWithMaterial(seeded, "ks1", `{"secret":"s","x":1}`);
    }),
    disconnect("foreign-material", { serverId: "__s-ks1__" }, async (seeded) => {
      await otherUser(seeded);
      await secret(seeded, "kother", JSON.stringify({ secret: "s" }), {
        userId: `${seeded.userId}-other`,
      });
      await server(seeded, "ks1", { secretId: id(seeded, "kother") });
    }),
    disconnect("session-other-user", { serverId: "__s-ks1__" }, async (seeded) => {
      await otherUser(seeded);
      await server(seeded, "ks1", { allSpaces: true });
      await session(seeded, "kses1", "ks1", { userId: `${seeded.userId}-other` });
      await session(seeded, "kses2", "ks1");
    }),
  ];
}
