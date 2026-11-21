import { ACTIVE_RUN_STATUSES, BACKGROUND_HELPER_TRIGGER } from "@rakazo/core";
import type { Prisma } from "../database/client.js";
import { clearEndedRunState } from "./run-secrets.js";

/**
 * The caller selects authorized runs and owns the surrounding transaction and cleanup. Returns
 * the runs this cancelled: one that finished after the caller's read keeps its outcome.
 */
export async function cancelRunsInTransaction<
  Run extends { id: string; taskId: string; userId: string; spaceId: string },
>(
  tx: Pick<
    Prisma.TransactionClient,
    "run" | "attempt" | "task" | "externalEffect" | "secret" | "message"
  >,
  runs: ReadonlyArray<Run>,
  cancelledAt: Date,
): Promise<Run[]> {
  if (runs.length === 0) return [];
  const cancelledIds = new Set(
    (
      await tx.run.updateManyAndReturn({
        where: { id: { in: runs.map((run) => run.id) }, status: { in: [...ACTIVE_RUN_STATUSES] } },
        data: {
          status: "cancelled",
          completedAt: cancelledAt,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
        select: { id: true },
      })
    ).map((run) => run.id),
  );
  const cancelled = runs.filter((run) => cancelledIds.has(run.id));
  if (cancelled.length === 0) return [];
  const runIds = cancelled.map((run) => run.id);
  await clearEndedRunState(tx, runIds);
  await tx.attempt.updateMany({
    where: { runId: { in: runIds }, status: "running" },
    data: { status: "cancelled", finishedAt: cancelledAt },
  });
  await tx.task.updateMany({
    where: { id: { in: cancelled.map((run) => run.taskId) } },
    data: { status: "cancelled" },
  });
  return cancelled;
}

/**
 * The background helpers a thread started, and the helpers those started in turn: their runs
 * work in threads of their own, so only their card points back. `messageId` narrows it to the
 * helper behind that card of the thread, with what it started.
 */
export function startedHelpersWhere(threadId: string, messageId?: string): Prisma.RunWhereInput {
  const card: Prisma.MessageWhereInput = { threadId, ...(messageId ? { id: messageId } : {}) };
  const startedBy: Prisma.RunWhereInput = {
    trigger: BACKGROUND_HELPER_TRIGGER,
    sourceMessage: card,
  };
  return {
    trigger: BACKGROUND_HELPER_TRIGGER,
    OR: [{ sourceMessage: card }, { sourceMessage: { thread: { runs: { some: startedBy } } } }],
  };
}

/** Work in a conversation, including delegates whose execution history lives elsewhere. */
export function conversationRunsWhere(threadId: string): Prisma.RunWhereInput {
  return { OR: [{ threadId }, startedHelpersWhere(threadId)] };
}
