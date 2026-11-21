import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createRepos,
  createThreadMessage,
  IsolationError,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveHelperThread } from "./helper-thread.js";
import { threadSnapshot } from "./thread-snapshot.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("reading a background helper's thread (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  const provisioned: { address: string; spaceId: string; userId: string }[] = [];
  let owner: Actor;
  let stranger: Actor;
  let chatThreadId: string;
  let cardId: string;
  let helperThreadId: string;
  let botId: string;

  async function identity(label: string) {
    const address = `helper-thread-${label}-${randomUUID()}`;
    const found = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(prisma, { provider: "test", address }),
    );
    provisioned.push({ address, spaceId: found.spaceId, userId: found.userId });
    return {
      ...found,
      actor: {
        userId: found.userId,
        spaceId: found.spaceId,
        email: `${label}@example.com`,
        isDeploymentOwner: false,
      } satisfies Actor,
    };
  }

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      try {
        await prisma.$disconnect();
      } finally {
        await db.pool.end();
      }
    };
    const mine = await identity("owner");
    owner = mine.actor;
    stranger = (await identity("stranger")).actor;
    ({ botId, threadId: chatThreadId } = mine);
    const card = await createThreadMessage(system, {
      threadId: chatThreadId,
      role: "bot",
      botId,
      blocks: [
        { kind: "subagent", agentId: randomUUID(), name: "scout", task: "t", status: "running" },
      ],
    });
    cardId = card.id;
    const own = await system.thread.create({
      data: { spaceId: owner.spaceId, userId: owner.userId, helperBotId: botId },
    });
    helperThreadId = own.id;
    const task = await system.task.create({
      data: {
        spaceId: owner.spaceId,
        botId,
        threadId: helperThreadId,
        userId: owner.userId,
        prompt: "t",
        status: "queued",
      },
    });
    await system.run.create({
      data: {
        spaceId: owner.spaceId,
        botId,
        threadId: helperThreadId,
        taskId: task.id,
        userId: owner.userId,
        status: "running",
        trigger: "helper",
        sourceMessageId: cardId,
      },
    });
    await createThreadMessage(system, {
      threadId: helperThreadId,
      role: "bot",
      botId,
      blocks: [{ kind: "text", text: "checked the first venue" }],
    });
  });

  afterAll(async () => {
    try {
      if (prisma) {
        for (const { address, spaceId, userId } of provisioned) {
          await system.messagingIdentity.deleteMany({ where: { provider: "test", address } });
          await system.organization.deleteMany({ where: { id: spaceId } });
          await system.user.deleteMany({ where: { id: userId } });
        }
      }
    } finally {
      await close?.();
    }
  });

  it("opens a helper's thread from the card that started it, with what it has written", async () => {
    const target = await runAsTenant(owner, () =>
      resolveHelperThread(prisma, owner, { messageId: cardId }),
    );
    expect(target).toMatchObject({ kind: "bot", botId, threadId: helperThreadId });
    const snapshot = await runAsTenant(owner, () =>
      threadSnapshot({ prisma }, target, owner.userId),
    );
    expect(snapshot.threadId).toBe(helperThreadId);
    expect(snapshot.messages.map((message) => message.blocks)).toEqual([
      [{ kind: "text", text: "checked the first venue" }],
    ]);
    // And again by the thread's id, as a live subscription finds it.
    await expect(
      runAsTenant(owner, () => resolveHelperThread(prisma, owner, { threadId: helperThreadId })),
    ).resolves.toMatchObject({ threadId: helperThreadId });
  });

  it("is not a way into a chat, or into another Space's helper", async () => {
    await expect(
      runAsTenant(owner, () => resolveHelperThread(prisma, owner, { threadId: chatThreadId })),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      runAsTenant(stranger, () => resolveHelperThread(prisma, stranger, { messageId: cardId })),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      runAsTenant(stranger, () =>
        resolveHelperThread(prisma, stranger, { threadId: helperThreadId }),
      ),
    ).rejects.toBeInstanceOf(IsolationError);
    // The tenant's own bots stay reachable only through their own Space.
    expect(await runAsTenant(owner, () => createRepos(prisma).getBot(owner, botId))).toMatchObject({
      id: botId,
    });
  });
});
