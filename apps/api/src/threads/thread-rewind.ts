import type { JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import { wakeRun } from "@rakazo/adapters";
import type { Actor, MessageBlock } from "@rakazo/contracts";
import { ClientError, projectMessages } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  SpaceDeletionInProgressError,
  spaceTakesWork,
  storedMessageBlocks,
  THREAD_LOCK_TRANSACTION_OPTIONS,
  withTransactionRetry,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { cancelThreadRuns, finishThreadStop } from "./thread-stop.js";
import type { ThreadTarget } from "./thread-target.js";
import { cancelSupersededQueuedRuns, RUNS_NEEDING_CONTINUE } from "./thread-target.js";

export interface RewindThreadInput {
  messageId: string;
  runId?: string;
  stepIndex: number;
  stepLabel?: string;
  stepDetail?: string;
  clientNonce?: string;
}

type StepsBlock = Extract<MessageBlock, { kind: "steps" }>;
type ToolStep = StepsBlock["steps"][number];

type RewindDeps = {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  jobs: JobPublisher;
  events: Pick<ThreadEvents, "notify" | "publishSpaceChange">;
};

export async function rewindThreadRun(
  deps: RewindDeps,
  actor: Actor,
  target: ThreadTarget,
  input: RewindThreadInput,
) {
  const commit = () =>
    deps.prisma.$transaction(async (tx) => {
      if (!(await spaceTakesWork(tx, actor.spaceId))) throw new SpaceDeletionInProgressError();
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;

      if (input.clientNonce) {
        const existingMessage = await tx.message.findFirst({
          where: { threadId: target.threadId, clientNonce: input.clientNonce },
          select: { id: true, runId: true, blocks: true },
        });
        if (existingMessage?.runId) {
          const existingRun = await tx.run.findUnique({
            where: { id: existingMessage.runId },
            select: { id: true, taskId: true, status: true },
          });
          if (existingRun) {
            const existingSteps = findLastStepsBlock(storedMessageBlocks(existingMessage));
            return {
              replay: true as const,
              runId: existingRun.id,
              taskId: existingRun.taskId,
              attempt: existingSteps?.attempts ?? 2,
              status: existingRun.status,
            };
          }
        }
      }

      const source = await loadRewindSource(tx, target, input);
      if (input.stepIndex < 0 || input.stepIndex >= source.stepsBlock.steps.length) {
        throw new ClientError("BAD_REQUEST", "Rewind step index is out of range.");
      }

      const botId = source.botId ?? (target.kind === "bot" ? target.botId : target.memberBotIds[0]);
      if (!botId) throw new ClientError("NOT_FOUND", "No bot available to rewind.");

      const prevAttempts = Math.max(
        source.stepsBlock.attempts ?? 1,
        ...source.stepsBlock.steps.map((step) => step.attempt ?? 1),
      );
      const nextAttempt = prevAttempts + 1;
      const rewoundSteps: ToolStep[] = source.stepsBlock.steps.map((step, index) => {
        const attempt = step.attempt ?? (index >= input.stepIndex ? prevAttempts : 1);
        if (index < input.stepIndex) {
          return {
            ...step,
            attempt,
            status: step.status && step.status !== "running" ? step.status : "done",
          };
        }
        return {
          ...step,
          attempt,
          status: "stopped",
        };
      });

      const priorCostUsd = await resolvePriorCostUsd(tx, source.stepsBlock, source.runId);
      const stop = await cancelThreadRuns(actor, target)(tx);

      const targetStep = source.stepsBlock.steps[input.stepIndex]!;
      const label = input.stepLabel?.trim() || targetStep.label;
      const detail = input.stepDetail?.trim() || targetStep.detail;
      const prompt = [
        `Rewound to step ${input.stepIndex + 1} (${label}${detail ? `: ${detail}` : ""}) for retry attempt #${nextAttempt}.`,
        "Earlier steps shown in the checkpoint history remain completed; steps from that point onward were stopped. Re-attempt cleanly from this checkpoint without repeating unnecessary completed setup.",
      ].join("\n");

      const checkpointStepsBlock: StepsBlock = {
        kind: "steps",
        steps: rewoundSteps,
        attempts: nextAttempt,
        ...(priorCostUsd !== undefined ? { costUsd: priorCostUsd } : {}),
        ...(source.modelId ? { modelId: source.modelId } : {}),
        ...(source.modelProvider ? { modelProvider: source.modelProvider } : {}),
      };
      const deliveryBlocks: MessageBlock[] = [
        { kind: "delivery" },
        { kind: "text", text: prompt },
        checkpointStepsBlock,
      ];

      const deliveryMessage = await createThreadMessageInTransaction(tx, {
        threadId: target.threadId,
        role: "user",
        authorUserId: actor.userId,
        blocks: deliveryBlocks,
        ...(input.clientNonce ? { clientNonce: input.clientNonce } : {}),
      });

      const task = await tx.task.create({
        data: {
          spaceId: actor.spaceId,
          botId,
          threadId: target.threadId,
          userId: actor.userId,
          prompt,
          status: "queued",
        },
      });
      const run = await tx.run.create({
        data: {
          spaceId: actor.spaceId,
          botId,
          threadId: target.threadId,
          taskId: task.id,
          userId: actor.userId,
          status: "queued",
          trigger: "user",
          sourceMessageId: deliveryMessage.id,
          ...(input.clientNonce ? { clientNonce: `rewind:${deliveryMessage.id}` } : {}),
        },
      });
      await tx.message.update({ where: { id: deliveryMessage.id }, data: { runId: run.id } });
      await cancelSupersededQueuedRuns(tx, {
        threadId: target.threadId,
        botIds: [botId],
        keepRunIds: [run.id],
      });

      const checkpointEvent = await appendEventInTransaction(tx, {
        spaceId: actor.spaceId,
        threadId: target.threadId,
        botId,
        type: "run.checkpointed",
        runId: run.id,
        payload: {
          steps: rewoundSteps,
          attempts: nextAttempt,
          ...(priorCostUsd !== undefined ? { costUsd: priorCostUsd } : {}),
          ...(source.modelId ? { modelId: source.modelId } : {}),
          ...(source.modelProvider ? { modelProvider: source.modelProvider } : {}),
        },
      });

      return {
        replay: false as const,
        runId: run.id,
        taskId: task.id,
        attempt: nextAttempt,
        stop,
        eventSeq: checkpointEvent.seq,
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
      taskId: committed.taskId,
      attempt: committed.attempt,
    };
  }

  if (committed.stop.runIds.length > 0) {
    await finishThreadStop(deps, actor, target, committed.stop);
  }
  await deps.events.notify(target.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("thread rewind realtime notification", error);
  });
  await deps.events.publishSpaceChange?.(actor.spaceId, "runs");
  await wakeRun(deps.jobs, committed.runId);
  return {
    ok: true as const,
    runId: committed.runId,
    taskId: committed.taskId,
    attempt: committed.attempt,
  };
}

function findLastStepsBlock(blocks: readonly MessageBlock[]): StepsBlock | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.kind === "steps") return block;
  }
  return undefined;
}

async function loadRewindSource(
  tx: Prisma.TransactionClient,
  target: ThreadTarget,
  input: RewindThreadInput,
) {
  let stepsBlock: StepsBlock | undefined;
  let sourceBotId: string | undefined;
  let sourceRunId: string | undefined = input.runId;

  if (!input.messageId.startsWith("progress:")) {
    const message = await tx.message.findFirst({
      where: { id: input.messageId, threadId: target.threadId },
      select: { id: true, botId: true, runId: true, blocks: true },
    });
    if (!message) {
      throw new ClientError("NOT_FOUND", "The message to rewind could not be found.");
    }
    sourceBotId = message.botId ?? undefined;
    sourceRunId = input.runId ?? message.runId ?? undefined;
    stepsBlock = findLastStepsBlock(storedMessageBlocks(message));
  } else if (!sourceRunId) {
    sourceRunId = input.messageId.slice("progress:".length);
  }

  let runMeta: { botId: string; modelProvider: string | null; modelId: string | null } | null =
    null;
  if (sourceRunId) {
    runMeta = await tx.run.findFirst({
      where: { id: sourceRunId, threadId: target.threadId },
      select: { botId: true, modelProvider: true, modelId: true },
    });
    sourceBotId ??= runMeta?.botId;
  }

  if (!stepsBlock && sourceRunId) {
    const events = await tx.event.findMany({
      where: {
        threadId: target.threadId,
        runId: sourceRunId,
        type: {
          in: [
            "thread.progress",
            "thread.thinking",
            "agent.tool.called",
            "agent.tool.completed",
            "usage.recorded",
            "run.checkpointed",
          ],
        },
      },
      orderBy: { seq: "asc" },
    });
    const projected = projectMessages(events);
    for (let index = projected.length - 1; index >= 0; index -= 1) {
      stepsBlock = findLastStepsBlock(projected[index]!.blocks);
      if (stepsBlock) break;
    }
  }

  if (!stepsBlock || stepsBlock.steps.length === 0) {
    throw new ClientError("NOT_FOUND", "No checkpoint steps were found for that message.");
  }

  return {
    stepsBlock,
    botId: sourceBotId,
    runId: sourceRunId,
    modelId: stepsBlock.modelId ?? runMeta?.modelId ?? undefined,
    modelProvider: stepsBlock.modelProvider ?? runMeta?.modelProvider ?? undefined,
  };
}

async function resolvePriorCostUsd(
  tx: Prisma.TransactionClient,
  stepsBlock: StepsBlock,
  runId: string | undefined,
): Promise<number | undefined> {
  if (typeof stepsBlock.costUsd === "number" && Number.isFinite(stepsBlock.costUsd)) {
    return stepsBlock.costUsd;
  }
  if (
    !runId ||
    typeof (tx as Partial<Prisma.TransactionClient>).usageRecord?.aggregate !== "function"
  ) {
    return undefined;
  }
  const agg = await tx.usageRecord.aggregate({
    where: { runId },
    _sum: { costUsd: true },
  });
  const cost = agg._sum.costUsd;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}
