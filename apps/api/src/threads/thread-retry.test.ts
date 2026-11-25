import type { Actor } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { retryThreadRun } from "./thread-retry.js";
import type { ThreadTarget } from "./thread-target.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};

const botTarget: ThreadTarget = {
  kind: "bot",
  botId: "bot-1",
  threadId: "thread-1",
  bot: { id: "bot-1", spaceId: "space-1", name: "Helper", computer: null } as never,
};

function makeDeps(options: {
  run?: {
    id: string;
    botId: string;
    taskId: string;
    userId: string;
    status: string;
    trigger: string;
    createdAt: Date;
  } | null;
  hasCheckpoint?: boolean;
  activeRun?: { id: string } | null;
  newestTerminal?: { id: string } | null;
  updateRunCount?: number;
}) {
  const runUpdateMany = vi.fn(async () => ({ count: options.updateRunCount ?? 1 }));
  const taskUpdateMany = vi.fn(async () => ({ count: 1 }));
  let runFindFirstCount = 0;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    space: { findUnique: vi.fn(async () => ({ deletingAt: null })) },
    externalEffect: {
      findFirst: vi.fn(async () => (options.hasCheckpoint ? { id: "chk-1" } : null)),
    },
    run: {
      findFirst: vi.fn(async () => {
        runFindFirstCount += 1;
        if (runFindFirstCount === 1) return options.run ?? null;
        if (runFindFirstCount === 2) return options.activeRun ?? null;
        return options.newestTerminal === undefined
          ? options.run
            ? { id: options.run.id }
            : null
          : options.newestTerminal;
      }),
      updateMany: runUpdateMany,
    },
    task: {
      updateMany: taskUpdateMany,
    },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;
  const enqueue = vi.fn(async () => undefined);
  const publishSpaceChange = vi.fn(async () => undefined);
  return {
    deps: {
      prisma,
      jobs: { enqueue } as never,
      events: { publishSpaceChange },
    },
    tx,
    runUpdateMany,
    taskUpdateMany,
    enqueue,
    publishSpaceChange,
  };
}

const failedRun = {
  id: "run-1",
  botId: "bot-1",
  taskId: "task-1",
  userId: "user-1",
  status: "failed",
  trigger: "user",
  createdAt: new Date("2026-11-25T10:00:00Z"),
};

describe("retryThreadRun", () => {
  it("re-queues a failed run without checkpoint as retry mode", async () => {
    const { deps, runUpdateMany, taskUpdateMany, enqueue, publishSpaceChange } = makeDeps({
      run: failedRun,
      hasCheckpoint: false,
    });
    const result = await retryThreadRun(deps, actor, botTarget, { runId: "run-1" });
    expect(result).toEqual({ ok: true, runId: "run-1", mode: "retry" });
    expect(runUpdateMany).toHaveBeenCalledWith({
      where: { id: "run-1", status: "failed" },
      data: {
        status: "queued",
        error: null,
        completedAt: null,
        wakeAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    expect(taskUpdateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: "failed" },
      data: { status: "queued" },
    });
    expect(publishSpaceChange).toHaveBeenCalledWith("space-1", "runs");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("reports continue mode when a saved turn checkpoint exists", async () => {
    const { deps, enqueue } = makeDeps({
      run: failedRun,
      hasCheckpoint: true,
    });
    const result = await retryThreadRun(deps, actor, botTarget, { runId: "run-1" });
    expect(result).toEqual({ ok: true, runId: "run-1", mode: "continue" });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("replays idempotently when the run is already queued or running", async () => {
    const { deps, runUpdateMany, enqueue } = makeDeps({
      run: { ...failedRun, status: "queued" },
      hasCheckpoint: true,
    });
    const result = await retryThreadRun(deps, actor, botTarget, { runId: "run-1" });
    expect(result).toEqual({ ok: true, runId: "run-1", mode: "continue" });
    expect(runUpdateMany).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("rejects retrying another user's run", async () => {
    const { deps } = makeDeps({
      run: { ...failedRun, userId: "user-2" },
    });
    await expect(retryThreadRun(deps, actor, botTarget, { runId: "run-1" })).rejects.toMatchObject({
      name: ClientError.name,
      kind: "FORBIDDEN",
    });
  });

  it("rejects retrying when the run is missing", async () => {
    const { deps } = makeDeps({ run: null });
    await expect(retryThreadRun(deps, actor, botTarget, { runId: "run-1" })).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
  });

  it("rejects retrying a completed run", async () => {
    const { deps } = makeDeps({
      run: { ...failedRun, status: "completed" },
    });
    await expect(retryThreadRun(deps, actor, botTarget, { runId: "run-1" })).rejects.toMatchObject({
      kind: "CONFLICT",
    });
  });

  it("rejects retrying when the bot already has an active run", async () => {
    const { deps } = makeDeps({
      run: failedRun,
      activeRun: { id: "run-active" },
    });
    await expect(retryThreadRun(deps, actor, botTarget, { runId: "run-1" })).rejects.toMatchObject({
      kind: "CONFLICT",
    });
  });

  it("rejects retrying a failed run superseded by a newer terminal run", async () => {
    const { deps } = makeDeps({
      run: failedRun,
      newestTerminal: { id: "run-2" },
    });
    await expect(retryThreadRun(deps, actor, botTarget, { runId: "run-1" })).rejects.toMatchObject({
      kind: "CONFLICT",
    });
  });
});
