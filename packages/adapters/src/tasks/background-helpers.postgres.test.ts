import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createThreadMessage,
  provisionMessagingIdentity,
  runAsSystem,
  storedMessageBlocks,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { returnHelperOutcome } from "./background-helpers.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("a helper that started a helper (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let provisioned = false;
  let userId: string;
  let spaceId: string;
  let botId: string;
  let chatThreadId: string;
  const address = `nested-helper-${randomUUID()}`;
  const deps = () => ({ prisma: system, events: { notify: async () => undefined } }) as never;

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
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(prisma, { provider: "test", address }),
    );
    provisioned = true;
    ({ userId, spaceId, botId, threadId: chatThreadId } = identity);
  });

  afterAll(async () => {
    try {
      if (prisma && provisioned) {
        await system.messagingIdentity.deleteMany({ where: { provider: "test", address } });
        await system.organization.deleteMany({ where: { id: spaceId } });
        await system.user.deleteMany({ where: { id: userId } });
      }
    } finally {
      await close?.();
    }
  });

  const card = (threadId: string, name: string) =>
    createThreadMessage(system, {
      threadId,
      role: "bot",
      botId,
      blocks: [{ kind: "subagent", agentId: randomUUID(), name, task: "t", status: "running" }],
    });

  /** A helper run in a thread of its own, started from `sourceMessageId`'s card. */
  async function helperRun(sourceMessageId: string, status: "running" | "completed") {
    const thread = await system.thread.create({
      data: { spaceId, userId, helperBotId: botId },
    });
    const task = await system.task.create({
      data: { spaceId, botId, threadId: thread.id, userId, prompt: "t", status: "queued" },
    });
    const run = await system.run.create({
      data: {
        spaceId,
        botId,
        threadId: thread.id,
        taskId: task.id,
        userId,
        status,
        trigger: "helper",
        sourceMessageId,
        ...(status === "completed" ? { completedAt: new Date() } : {}),
      },
    });
    return { thread, run };
  }

  const cardStatus = async (id: string) => {
    const message = await system.message.findUniqueOrThrow({ where: { id } });
    const block = storedMessageBlocks(message).find((entry) => entry.kind === "subagent");
    return block?.kind === "subagent" ? block : undefined;
  };

  it("answers the chat only after the helpers it started have returned and it has answered", async () => {
    const outer = await card(chatThreadId, "outer");
    const first = await helperRun(outer.id, "completed");
    const inner = await card(first.thread.id, "inner");
    const second = await helperRun(inner.id, "completed");

    // The outer helper ends its turn while the inner one works: nothing goes back yet.
    await returnHelperOutcome(
      deps(),
      { ...first.run, sourceMessageId: outer.id },
      {
        status: "completed",
        text: "started the inner helper",
      },
    );
    expect((await cardStatus(outer.id))?.status).toBe("running");
    expect(
      (await system.run.findUniqueOrThrow({ where: { id: first.run.id } })).botOutcomeReturnedAt,
    ).toBeNull();

    // The inner one returns to the outer helper, as a turn of its own thread under its run.
    await returnHelperOutcome(
      deps(),
      { ...second.run, sourceMessageId: inner.id },
      {
        status: "completed",
        text: "found three venues",
      },
    );
    expect((await cardStatus(inner.id))?.status).toBe("completed");
    expect((await cardStatus(outer.id))?.status).toBe("running");
    const turn = await system.run.findFirstOrThrow({
      where: { threadId: first.thread.id, clientNonce: `helper-result:${second.run.id}` },
    });
    expect(turn).toMatchObject({
      trigger: "helper",
      sourceMessageId: outer.id,
      delegatedFromRunId: first.run.id,
    });

    // That turn finishes: the outer helper's earlier turn only closes, the card is settled by
    // this one, and the chat gets the result as it does for any helper.
    await system.run.update({
      where: { id: turn.id },
      data: { status: "completed", completedAt: new Date() },
    });
    await returnHelperOutcome(deps(), first.run, { status: "completed", text: "earlier turn" });
    expect((await cardStatus(outer.id))?.status).toBe("running");
    await returnHelperOutcome(deps(), turn, { status: "completed", text: "three venues compared" });
    expect(await cardStatus(outer.id)).toMatchObject({
      status: "completed",
      result: "three venues compared",
    });
    expect(
      await system.run.count({
        where: { threadId: chatThreadId, trigger: "helper_result", delegatedFromRunId: turn.id },
      }),
    ).toBe(1);
  });
});
