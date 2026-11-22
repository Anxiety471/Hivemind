import { runContinueJob } from "@rakazo/adapter-kit";
import { settleRunSubagents } from "@rakazo/core";
import type * as Db from "@rakazo/db";
import { appendEventInTransaction, createThreadMessageInTransaction } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "../runs/assembly/run-context.js";
import { returnHelperOutcome, startBackgroundHelper } from "./background-helpers.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  assertRunCanWriteHistory: vi.fn(async () => undefined),
  createThreadMessageInTransaction: vi.fn(async () => ({ id: "card" })),
  appendEventInTransaction: vi.fn(async () => ({ seq: 7 })),
}));

const START = {
  name: "scout",
  task: "compare the venues",
  instructions: "",
  modelProvider: "",
  modelId: "",
  executionId: "call-1",
  effectKey: "effect-1",
};

/** A helper's own thread with no other turn and no helper started from it. */
function quietThread() {
  return {
    findUnique: vi.fn(async () => ({
      threadId: "helper-thread",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      trigger: "helper",
    })),
    findMany: vi.fn(async (_args: unknown): Promise<unknown[]> => []),
    count: vi.fn(async (_args: unknown) => 0),
  };
}

function harness(overrides: { trigger?: string; threadBotId?: string | null } = {}) {
  const createRun = vi.fn(async (_args: unknown) => ({ id: "helper-run" }));
  const tx = {
    $queryRaw: vi.fn(async () => []),
    message: {
      findMany: vi.fn(async (_args: unknown): Promise<{ id: string; blocks: unknown[] }[]> => []),
    },
    thread: { create: vi.fn(async () => ({ id: "helper-thread" })) },
    task: { create: vi.fn(async () => ({ id: "helper-task" })) },
    run: {
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      create: createRun,
    },
  };
  const prisma = {
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const enqueue = vi.fn(async () => undefined);
  const ctx = {
    deps: { prisma, events: { notify: vi.fn(async () => undefined) }, jobs: { enqueue } },
    run: { id: "run-1", spaceId: "space", userId: "user", trigger: overrides.trigger ?? "user" },
    runId: "run-1",
    bot: { id: "bot" },
    thread: {
      id: "chat",
      botId: overrides.threadBotId === undefined ? "bot" : overrides.threadBotId,
    },
  } as unknown as RunContext;
  return { ctx, prisma, createRun, enqueue, tx };
}

describe("starting a background helper", () => {
  it("starts one from the owner's own chat and queues its run", async () => {
    const h = harness();
    await expect(startBackgroundHelper(h.ctx, START)).resolves.toMatchObject({ ok: true });
    expect(h.createRun).toHaveBeenCalledWith({
      data: expect.objectContaining({
        threadId: "helper-thread",
        trigger: "helper",
        sourceMessageId: "card",
        status: "queued",
      }),
      select: { id: true },
    });
    expect(h.createRun.mock.calls[0]?.[0]).not.toHaveProperty("data.modelPinned");
    expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("helper-run"));
    // It takes the chat's lock, which a snapshot read can hold for a while.
    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 20_000,
    });
  });

  it("preserves the source user's attachments on the independent run", async () => {
    const h = harness();
    h.ctx.run.sourceMessageId = "user-message";
    const file = {
      kind: "file",
      artifactId: "artifact-1",
      name: "notes.txt",
      mimeType: "text/plain",
      size: 12,
    };
    h.tx.message.findMany.mockResolvedValue([
      { id: "user-message", blocks: [{ kind: "text", text: "Summarize this" }, file] },
    ]);
    await startBackgroundHelper(h.ctx, START);
    expect(h.tx.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadId: "chat",
          role: "user",
          OR: [
            { id: "user-message" },
            { steeringMessages: { some: { runId: "run-1", claimedAt: { not: null } } } },
          ],
        }),
      }),
    );
    expect(createThreadMessageInTransaction).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({
        threadId: "helper-thread",
        runId: "helper-run",
        role: "user",
        blocks: [file],
        markUnread: false,
      }),
    );
  });

  it("keeps its card running when the turn that started it ends", async () => {
    const h = harness();
    await startBackgroundHelper(h.ctx, START);
    const [, input] = vi.mocked(createThreadMessageInTransaction).mock.lastCall!;
    const [, event] = vi.mocked(appendEventInTransaction).mock.lastCall!;
    // The turn's run.completed settles that turn's helper cards on every live client.
    const card = { id: "card", runId: input.runId, blocks: input.blocks };
    expect(settleRunSubagents([card], h.ctx.runId)).toEqual([card]);
    expect(event.runId).toBeUndefined();
  });

  it.each([{ threadBotId: null }, { trigger: "messaging" }])(
    "delegates from any chat surface",
    async (overrides) => {
      const h = harness(overrides);
      await expect(startBackgroundHelper(h.ctx, START)).resolves.toMatchObject({ ok: true });
      expect(h.createRun).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            delegatedFromRunId: "run-1",
            sourceMessageId: "card",
          }),
        }),
      );
    },
  );

  it.each([
    ["a routine", { trigger: "routine" }],
    ["another bot's request", { trigger: "bot_message" }],
    ["a helper's result coming back", { trigger: "helper_result" }],
  ])("refuses to start one from %s", async (_label, overrides) => {
    const h = harness(overrides);
    await expect(startBackgroundHelper(h.ctx, START)).resolves.toEqual({
      error: expect.stringContaining("cannot delegate further"),
    });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("inherits a model explicitly pinned on the parent run", async () => {
    const h = harness();
    Object.assign(h.ctx.run, { modelPinned: true, modelProvider: "fixture", modelId: "pinned" });
    await startBackgroundHelper(h.ctx, START);
    expect(h.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modelProvider: "fixture",
          modelId: "pinned",
          modelPinned: true,
        }),
      }),
    );
  });

  it("pins the model it was asked for, and needs both halves of it", async () => {
    const h = harness();
    await startBackgroundHelper(h.ctx, { ...START, modelProvider: "openai", modelId: "gpt-x" });
    expect(h.createRun).toHaveBeenCalledWith({
      data: expect.objectContaining({
        modelProvider: "openai",
        modelId: "gpt-x",
        modelPinned: true,
      }),
      select: { id: true },
    });
    const half = harness();
    await expect(
      startBackgroundHelper(half.ctx, { ...START, modelProvider: "openai" }),
    ).resolves.toEqual({ error: "model_provider and model_id must both be set" });
    expect(half.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("returning a helper's outcome", () => {
  it("waits for the chat's lock with the thread-lock budget", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: { ...quietThread(), updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    const prisma = {
      message: { findUnique: vi.fn(async () => ({ threadId: "chat" })) },
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const run = { id: "helper-run", spaceId: "space", botId: "bot", userId: "user" };
    await returnHelperOutcome(
      { prisma, events: { notify: vi.fn() } } as never,
      { ...run, sourceMessageId: "card" },
      { status: "completed", text: "done" },
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 20_000 });
  });
});

describe("passing a helper's result back in a shared space", () => {
  // The bot was made by "creator"; "member" shares the space and started the helper.
  function shared(
    overrides: { member?: boolean; archived?: boolean; attachments?: unknown[] } = {},
  ) {
    const createRun = vi.fn(async (_args: unknown) => ({ id: "wake" }));
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: { ...quietThread(), updateMany: vi.fn(async () => ({ count: 1 })), create: createRun },
      message: {
        findMany: vi.fn(async () =>
          overrides.attachments ? [{ id: "helper-file", blocks: overrides.attachments }] : [],
        ),
        findFirst: vi.fn(async () => ({
          id: "card",
          threadId: "chat",
          blocks: [
            { kind: "subagent", agentId: "call-1", name: "scout", task: "t", status: "running" },
          ],
        })),
        update: vi.fn(async () => ({})),
      },
      spaceMember: {
        findUnique: vi.fn(async () => (overrides.member === false ? null : { id: "membership" })),
      },
      bot: {
        findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
          overrides.archived ||
          (where.userId !== undefined && where.userId !== "creator") ||
          where.archivedAt !== null
            ? null
            : { id: "bot" },
        ),
      },
      task: { create: vi.fn(async () => ({ id: "wake-task" })) },
    };
    const prisma = {
      message: { findUnique: vi.fn(async () => ({ threadId: "chat" })) },
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const enqueue = vi.fn(async () => undefined);
    const run = {
      id: "helper-run",
      spaceId: "space",
      botId: "bot",
      userId: "member",
      sourceMessageId: "card",
    };
    const returned = returnHelperOutcome(
      { prisma, events: { notify: vi.fn(async () => undefined) }, jobs: { enqueue } } as never,
      run,
      { status: "completed", text: "found three venues" },
    );
    return { returned, createRun, enqueue };
  }

  it("returns attached files to the conversation under the result run", async () => {
    const file = {
      kind: "file",
      artifactId: "file-1",
      name: "notes.txt",
      mimeType: "text/plain",
      size: 12,
    };
    const h = shared({ attachments: [file] });
    await h.returned;
    expect(createThreadMessageInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ threadId: "chat", runId: "wake", blocks: [file] }),
    );
  });

  it("brings it back for a member who did not make the bot, as their own turn", async () => {
    const h = shared();
    await h.returned;
    expect(h.createRun).toHaveBeenCalledWith({
      data: expect.objectContaining({
        threadId: "chat",
        userId: "member",
        trigger: "helper_result",
        clientNonce: "helper-result:helper-run",
      }),
      select: { id: true },
    });
    expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("wake"));
  });

  it.each([
    ["the member has left the space", { member: false }],
    ["the bot is archived", { archived: true }],
  ])("only settles the card when %s", async (_label, overrides) => {
    const h = shared(overrides);
    await h.returned;
    expect(h.createRun).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

describe("helpers that start helpers", () => {
  const SETTLED = new Date("2026-01-01T00:00:00Z");
  const EARLIER = new Date("2025-12-31T23:55:00Z");
  const LATER = new Date("2026-01-01T00:05:00Z");
  const running = { kind: "subagent", agentId: "a", name: "scout", task: "t", status: "running" };

  /** A run in a helper's own thread, which is where a nested helper's result comes back. */
  function nested(
    overrides: {
      /** Other helper turns in the run's own thread. */
      turns?: { id: string; status: string; createdAt: Date }[];
      /** Helpers started from that thread that are working or have not returned. */
      pendingChildren?: number;
      /** The card sits in a helper's thread, not in a chat. */
      cardInHelperThread?: boolean;
      ownerCardStatus?: "running" | "completed";
    } = {},
  ) {
    const createRun = vi.fn(async (_args: unknown) => ({ id: "wake" }));
    const updateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
    const messageUpdate = vi.fn(async () => ({}));
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: {
        findUnique: vi.fn(async () => ({
          threadId: overrides.cardInHelperThread ? "child-thread" : "helper-thread",
          createdAt: SETTLED,
          trigger: "helper",
        })),
        findMany: vi.fn(async () => overrides.turns ?? []),
        count: vi.fn(async () => overrides.pendingChildren ?? 0),
        findFirst: vi.fn(async () => ({
          id: "outer-run",
          sourceMessageId: "outer-card",
          modelProvider: null,
          modelId: null,
          modelPinned: false,
          sourceMessage: {
            id: "outer-card",
            blocks: [{ ...running, status: overrides.ownerCardStatus ?? "running" }],
          },
        })),
        updateMany,
        create: createRun,
      },
      message: {
        findMany: vi.fn(async () => []),
        findFirst: vi.fn(async () => ({
          id: "card",
          threadId: overrides.cardInHelperThread ? "helper-thread" : "chat",
          blocks: [running],
          thread: { helperBotId: overrides.cardInHelperThread ? "bot" : null, group: null },
        })),
        update: messageUpdate,
      },
      spaceMember: { findUnique: vi.fn(async () => ({ id: "membership" })) },
      bot: { findFirst: vi.fn(async () => ({ id: "bot" })) },
      task: { create: vi.fn(async () => ({ id: "wake-task" })) },
    };
    const prisma = {
      message: {
        findUnique: vi.fn(async () => ({
          threadId: overrides.cardInHelperThread ? "helper-thread" : "chat",
        })),
      },
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const enqueue = vi.fn(async () => undefined);
    const returned = returnHelperOutcome(
      { prisma, events: { notify: vi.fn(async () => undefined) }, jobs: { enqueue } } as never,
      {
        id: "helper-run",
        spaceId: "space",
        botId: "bot",
        userId: "user",
        sourceMessageId: "card",
      },
      { status: "completed", text: "found three venues" },
    );
    return { returned, createRun, updateMany, messageUpdate, enqueue };
  }

  it("holds back a helper's answer while a helper it started is still working", async () => {
    const h = nested({ pendingChildren: 1 });
    await h.returned;
    // Nothing is claimed, so the answer comes once the last of them has returned.
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.messageUpdate).not.toHaveBeenCalled();
    expect(h.createRun).not.toHaveBeenCalled();
  });

  it("holds back an answer while another turn of the same helper is working", async () => {
    const h = nested({ turns: [{ id: "other", status: "running", createdAt: EARLIER }] });
    await h.returned;
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.createRun).not.toHaveBeenCalled();
  });

  it("lets a later turn of the helper answer in place of an earlier one", async () => {
    const h = nested({ turns: [{ id: "later", status: "queued", createdAt: LATER }] });
    await h.returned;
    // The earlier turn is only marked returned: the card is the later turn's to settle.
    expect(h.updateMany).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "helper-run" }) }),
    );
    expect(h.messageUpdate).not.toHaveBeenCalled();
    expect(h.createRun).not.toHaveBeenCalled();
  });

  it("brings a nested helper's result back to the helper that started it, as its own turn", async () => {
    const h = nested({ cardInHelperThread: true });
    await h.returned;
    expect(h.createRun).toHaveBeenCalledWith({
      data: expect.objectContaining({
        threadId: "helper-thread",
        trigger: "helper",
        sourceMessageId: "outer-card",
        delegatedFromRunId: "outer-run",
        clientNonce: "helper-result:helper-run",
      }),
      select: { id: true },
    });
    expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("wake"));
  });

  it("only settles the card when the helper it belongs to is already settled", async () => {
    const h = nested({ cardInHelperThread: true, ownerCardStatus: "completed" });
    await h.returned;
    expect(h.messageUpdate).toHaveBeenCalledOnce();
    expect(h.createRun).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  /** A helper turn whose card is in `cardThread`, the chat or another helper's thread. */
  function startFromHelper(cardThread: { id: string; helperBotId: string | null }, cap = 0) {
    const h = harness({ trigger: "helper" });
    Object.assign(h.ctx.run, {
      threadId: "helper-thread",
      sourceMessageId: "outer-card",
    });
    Object.assign(h.ctx.thread, { id: "helper-thread" });
    Object.assign(h.ctx.deps.prisma, {
      message: {
        findUnique: vi.fn(async () => ({
          threadId: cardThread.id,
          thread: { helperBotId: cardThread.helperBotId },
        })),
      },
      run: { findFirst: vi.fn(async () => ({ sourceMessage: { threadId: "chat" } })) },
    });
    // The harness declares a no-argument mock; the helper lookup passes a where clause.
    h.tx.run.findFirst = vi.fn(async (args: unknown) =>
      (args as { where: { clientNonce?: string } }).where.clientNonce
        ? null
        : ({ id: "outer-run" } as never),
    ) as unknown as typeof h.tx.run.findFirst;
    h.tx.run.count.mockResolvedValue(cap);
    return h;
  }

  it("lets a helper started from a chat start helpers of its own, answering to its first run", async () => {
    const h = startFromHelper({ id: "chat", helperBotId: null });
    await expect(startBackgroundHelper(h.ctx, START)).resolves.toMatchObject({ ok: true });
    expect(h.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ trigger: "helper", delegatedFromRunId: "outer-run" }),
      }),
    );
  });

  it("stops at two levels: a helper that a helper started cannot start more", async () => {
    const h = startFromHelper({ id: "other-helper-thread", helperBotId: "bot" });
    await expect(startBackgroundHelper(h.ctx, START)).resolves.toEqual({
      error: expect.stringContaining("cannot delegate further"),
    });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("counts every working helper of the chat's tree against one cap", async () => {
    const h = startFromHelper({ id: "chat", helperBotId: null }, 8);
    await expect(startBackgroundHelper(h.ctx, START)).resolves.toEqual({
      error: expect.stringContaining("8 subagents"),
    });
    expect(h.createRun).not.toHaveBeenCalled();
  });
});
