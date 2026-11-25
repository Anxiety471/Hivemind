import type { JobPublisher } from "@rakazo/adapter-kit";
import { wakeRun } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  assertTransition,
  BACKGROUND_HELPER_TRIGGER,
  BACKGROUND_RUN_TRIGGERS,
  ClientError,
} from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  RUN_TURN_CHECKPOINT_KIND,
  SpaceDeletionInProgressError,
  spaceTakesWork,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@rakazo/db";
import type { ThreadTarget } from "./thread-target.js";
import { RUNS_NEEDING_CONTINUE } from "./thread-target.js";

export interface RetryThreadInput {
  runId: string;
}

type RetryDeps = {
  prisma: PrismaClient;
  jobs: JobPublisher;
  events: Pick<ThreadEvents, "publishSpaceChange">;
};

export async function retryThreadRun(
  deps: RetryDeps,
  actor: Actor,
  target: ThreadTarget,
  input: RetryThreadInput,
) {
  const commit = () =>
    deps.prisma.$transaction(async (tx) => {
      if (!(await spaceTakesWork(tx, actor.spaceId))) throw new SpaceDeletionInProgressError();
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;

      const run = await tx.run.findFirst({
        where: {
          id: input.runId,
          threadId: target.threadId,
          spaceId: actor.spaceId,
        },
        select: {
          id: true,
          botId: true,
          taskId: true,
          userId: true,
          status: true,
          trigger: true,
          createdAt: true,
        },
      });
      if (!run) {
        throw new ClientError("NOT_FOUND", "The failed run could not be found.");
      }
      if (run.userId !== actor.userId) {
        throw new ClientError("FORBIDDEN", "Only the person who started this run can retry it.");
      }
      if (isBackgroundRunTrigger(run.trigger) || run.trigger === BACKGROUND_HELPER_TRIGGER) {
        throw new ClientError("BAD_REQUEST", "This run cannot be retried.");
      }

      const checkpointRow = await tx.externalEffect.findFirst({
        where: {
          runId: run.id,
          kind: RUN_TURN_CHECKPOINT_KIND,
          status: RUN_TURN_CHECKPOINT_KIND,
        },
        select: { id: true },
      });
      const mode: "continue" | "retry" = checkpointRow ? "continue" : "retry";

      if (run.status === "queued" || run.status === "leased" || run.status === "running") {
        return {
          replay: true as const,
          runId: run.id,
          status: run.status,
          mode,
        };
      }
      if (run.status !== "failed") {
        throw new ClientError("CONFLICT", "Only a failed run can be retried.");
      }

      const activeRun = await tx.run.findFirst({
        where: {
          threadId: target.threadId,
          botId: run.botId,
          trigger: { notIn: [...BACKGROUND_RUN_TRIGGERS] },
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
        select: { id: true },
      });
      if (activeRun) {
        throw new ClientError("CONFLICT", "The bot is already working.");
      }

      const newestTerminal = await tx.run.findFirst({
        where: {
          threadId: target.threadId,
          botId: run.botId,
          trigger: { notIn: [...BACKGROUND_RUN_TRIGGERS] },
          status: { in: ["failed", "completed", "cancelled"] },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      if (newestTerminal?.id !== run.id) {
        throw new ClientError("CONFLICT", "A newer reply already superseded this failed run.");
      }

      assertTransition("failed", "queued");
      const updated = await tx.run.updateMany({
        where: { id: run.id, status: "failed" },
        data: {
          status: "queued",
          error: null,
          completedAt: null,
          wakeAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      if (updated.count !== 1) {
        throw new ClientError("CONFLICT", "Only a failed run can be retried.");
      }
      await tx.task.updateMany({
        where: { id: run.taskId, status: "failed" },
        data: { status: "queued" },
      });

      return {
        replay: false as const,
        runId: run.id,
        mode,
      };
    }, THREAD_LOCK_TRANSACTION_OPTIONS);

  const committed = await withTransactionRetry(commit);
  if (committed.replay) {
    if (RUNS_NEEDING_CONTINUE.has(committed.status)) {
      await wakeRun(deps.jobs, committed.runId);
    }
    return {
      ok: true as const,
      runId: committed.runId,
      mode: committed.mode,
    };
  }

  await deps.events.publishSpaceChange?.(actor.spaceId, "runs");
  await wakeRun(deps.jobs, committed.runId);
  return {
    ok: true as const,
    runId: committed.runId,
    mode: committed.mode,
  };
}

function isBackgroundRunTrigger(trigger: string): boolean {
  return (BACKGROUND_RUN_TRIGGERS as readonly string[]).includes(trigger);
}
