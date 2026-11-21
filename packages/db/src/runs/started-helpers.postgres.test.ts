import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "../database/client.js";
import { createDb } from "../database/client.js";
import { asSystem, runAsSystem } from "../database/row-security.js";
import { provisionMessagingIdentity } from "../messaging/messaging.js";
import { createThreadMessage } from "../threads/messages.js";
import { conversationRunsWhere, startedHelpersWhere } from "./cancel-runs.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

describePostgres("the helpers a chat started (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let provisioned = false;
  let userId: string;
  let spaceId: string;
  let botId: string;
  let chatThreadId: string;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      try {
        await db.prisma.$disconnect();
      } finally {
        await db.pool.end();
      }
    };
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(prisma, { provider: "sendblue", address }),
    );
    ({ userId, spaceId, botId, threadId: chatThreadId } = identity);
    provisioned = true;
  });

  afterAll(async () => {
    try {
      if (prisma && provisioned) {
        await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
        await system.organization.deleteMany({ where: { id: spaceId } });
        await system.user.deleteMany({ where: { id: userId } });
      }
    } finally {
      await close?.();
    }
  });

  /** A card in `threadId` and the helper run it started, working in a thread of its own. */
  async function helperOf(threadId: string) {
    const card = await createThreadMessage(system, {
      threadId,
      role: "bot",
      botId,
      blocks: [
        { kind: "subagent", agentId: randomUUID(), name: "scout", task: "t", status: "running" },
      ],
    });
    const own = await system.thread.create({ data: { spaceId, userId, helperBotId: botId } });
    const task = await system.task.create({
      data: { spaceId, botId, threadId: own.id, userId, prompt: "t", status: "queued" },
    });
    const run = await system.run.create({
      data: {
        spaceId,
        botId,
        threadId: own.id,
        taskId: task.id,
        userId,
        status: "running",
        trigger: "helper",
        sourceMessageId: card.id,
      },
    });
    return { card, thread: own, run };
  }

  const idsOf = async (where: Prisma.RunWhereInput) =>
    (await system.run.findMany({ where, select: { id: true } })).map((run) => run.id).sort();

  it("reaches the helpers that helpers started, and only this chat's", async () => {
    const first = await helperOf(chatThreadId);
    const nested = await helperOf(first.thread.id);
    const sibling = await helperOf(chatThreadId);
    // Any thread a card can sit in; a thread needs an owner, and a helper thread has one.
    const elsewhere = await system.thread.create({ data: { spaceId, userId, helperBotId: botId } });
    const other = await helperOf(elsewhere.id);

    expect(await idsOf(startedHelpersWhere(chatThreadId))).toEqual(
      [first.run.id, nested.run.id, sibling.run.id].sort(),
    );
    expect(await idsOf(startedHelpersWhere(elsewhere.id))).toEqual([other.run.id]);
    // One card stops its own helper and what that started, not its sibling.
    expect(await idsOf(startedHelpersWhere(chatThreadId, first.card.id))).toEqual(
      [first.run.id, nested.run.id].sort(),
    );
    // The card must be in the thread asked about.
    expect(await idsOf(startedHelpersWhere(elsewhere.id, first.card.id))).toEqual([]);
    expect(await idsOf(conversationRunsWhere(chatThreadId))).toEqual(
      expect.arrayContaining([first.run.id, nested.run.id, sibling.run.id]),
    );
    expect(await idsOf(conversationRunsWhere(chatThreadId))).not.toContain(other.run.id);
  });
});
