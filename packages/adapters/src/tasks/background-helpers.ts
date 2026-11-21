import type { MessageBlock } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  BACKGROUND_HELPER_TRIGGER,
  HELPER_RESULT_TRIGGER,
  isApprovalAskBlock,
  isConversationalRun,
  MAX_HELPER_DEPTH,
  MAX_HELPERS_PER_CHAT,
  STOPPED_HELPER_RESULT,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  assertRunCanWriteHistory,
  changeMessageBlocks,
  createThreadMessageInTransaction,
  startedHelpersWhere,
  storedMessageBlocks,
  THREAD_LOCK_TRANSACTION_OPTIONS,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { RunContext } from "../runs/assembly/run-context.js";
import { runLeaseFor } from "../runs/assembly/run-messages.js";
import type { ExecutorDeps } from "../runs/executor/executor-deps.js";
import { wakeRun } from "../runs/wakeups/wake-run.js";
import { helperResultText } from "../runtime/pi/tools/pi-runtime-subagent.js";
import {
  backgroundHelperLimitNote,
  helperPrompt,
  helperWorkFolder,
  resultPrompt,
  SUBAGENT_DELEGATION_UNAVAILABLE,
  startedNote,
} from "./background-helpers.prompt.js";

const RESULT_LIMIT = 12_000;

// Stop only settles a card, so it brings no job queue.
type HelperDeps = Pick<ExecutorDeps, "prisma"> & {
  events: Pick<ExecutorDeps["events"], "notify">;
  jobs?: ExecutorDeps["jobs"];
};
type HelperBlock = Extract<MessageBlock, { kind: "subagent" }>;

/**
 * Delegation has one behavior in every conversation, without recursive result chains. A helper
 * may start helpers of its own until the depth limit; `helperDepth` is how deep this turn is
 * (see `helperPlace`), and a helper turn without it may not delegate.
 */
export function backgroundHelpersAllowed(turn: { trigger: string; helperDepth?: number }): boolean {
  if (turn.trigger === BACKGROUND_HELPER_TRIGGER) {
    return (turn.helperDepth ?? MAX_HELPER_DEPTH) < MAX_HELPER_DEPTH;
  }
  return turn.trigger !== HELPER_RESULT_TRIGGER && isConversationalRun(turn.trigger);
}

/**
 * Where a run sits among helpers: 0 in a chat, 1 for a helper its bot started there, 2 for one
 * that helper started. `chatThreadId` is the chat the whole tree belongs to: the thread of the
 * card that started the outermost helper. A helper's own thread is no chat, so a card that
 * lives there is one level further in.
 */
export async function helperPlace(
  prisma: Pick<PrismaClient, "message" | "run">,
  run: { trigger: string; threadId: string; sourceMessageId?: string | null },
): Promise<{ depth: number; chatThreadId: string }> {
  if (run.trigger !== BACKGROUND_HELPER_TRIGGER) return { depth: 0, chatThreadId: run.threadId };
  const card = run.sourceMessageId
    ? await prisma.message.findUnique({
        where: { id: run.sourceMessageId },
        select: { threadId: true, thread: { select: { helperBotId: true } } },
      })
    : null;
  if (!card) return { depth: 1, chatThreadId: run.threadId };
  if (!card.thread?.helperBotId) return { depth: 1, chatThreadId: card.threadId };
  const outermost = await prisma.run.findFirst({
    where: { threadId: card.threadId, trigger: BACKGROUND_HELPER_TRIGGER },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { sourceMessage: { select: { threadId: true } } },
  });
  return {
    depth: MAX_HELPER_DEPTH,
    chatThreadId: outermost?.sourceMessage?.threadId ?? card.threadId,
  };
}

/**
 * The run a new helper answers to. Inside a helper that is the first run of its thread, however
 * many turns the helper has had, so the chain back to the chat stays two links long.
 */
async function outermostRunId(
  tx: Pick<Prisma.TransactionClient, "run">,
  run: { trigger: string; threadId: string },
  runId: string,
): Promise<string> {
  if (run.trigger !== BACKGROUND_HELPER_TRIGGER) return runId;
  const first = await tx.run.findFirst({
    where: { threadId: run.threadId, trigger: BACKGROUND_HELPER_TRIGGER },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return first?.id ?? runId;
}

export async function startBackgroundHelper(
  ctx: RunContext,
  input: {
    name: string;
    task: string;
    instructions: string;
    modelProvider: string;
    modelId: string;
    executionId: string;
    effectKey: string;
  },
) {
  const { deps, run, runId, bot, thread } = ctx;
  const place = await helperPlace(deps.prisma, run);
  if (!backgroundHelpersAllowed({ trigger: run.trigger, helperDepth: place.depth })) {
    return {
      error: SUBAGENT_DELEGATION_UNAVAILABLE,
    };
  }
  if (Boolean(input.modelProvider) !== Boolean(input.modelId)) {
    return { error: "model_provider and model_id must both be set" };
  }
  const modelProvider = input.modelProvider || (run.modelPinned ? run.modelProvider : "");
  const modelId = input.modelId || (run.modelPinned ? run.modelId : "");
  const clientNonce = `background-helper:${input.effectKey}`;
  const started = { ok: true as const, name: input.name, note: startedNote(input.name) };
  const card: HelperBlock = {
    kind: "subagent",
    agentId: input.executionId,
    name: input.name,
    task: input.task,
    status: "running",
  };
  const committed = await deps.prisma.$transaction(async (tx) => {
    // Every start goes through this chat, so its lock makes the replay check and the cap exact
    // even when one turn starts several helpers at once, and so does a helper's start: the cap
    // counts the chat's whole tree, so the chat is locked before the helper's own thread.
    if (thread.groupId)
      await tx.$queryRaw`SELECT id FROM chat_groups WHERE id = ${thread.groupId} FOR NO KEY UPDATE`;
    if (place.chatThreadId !== thread.id)
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${place.chatThreadId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${thread.id} FOR UPDATE`;
    if (
      await tx.run.findFirst({ where: { spaceId: run.spaceId, clientNonce }, select: { id: true } })
    )
      return null;
    const running = await tx.run.count({
      where: {
        ...startedHelpersWhere(place.chatThreadId),
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
    });
    if (running >= MAX_HELPERS_PER_CHAT) return "full" as const;
    // Only this turn's live worker may start one, but the card is not part of the turn: a turn
    // ending settles its own helper cards as stopped, while this helper keeps working.
    await assertRunCanWriteHistory(tx, runId, { lease: runLeaseFor(deps, runId) });
    const message = await createThreadMessageInTransaction(tx, {
      threadId: thread.id,
      role: "bot",
      blocks: [card],
      botId: bot.id,
      markUnread: false,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: thread.id,
      botId: bot.id,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks: [card] },
    });
    // The helper's own thread: no chat list shows it, nothing sent to the bot waits behind the
    // helper, and it goes when the bot is deleted.
    const helperThread = await tx.thread.create({
      data: { spaceId: run.spaceId, userId: run.userId, helperBotId: bot.id },
      select: { id: true },
    });
    const task = await tx.task.create({
      data: {
        spaceId: run.spaceId,
        botId: bot.id,
        threadId: helperThread.id,
        userId: run.userId,
        prompt: helperPrompt({
          ...input,
          canDelegate: place.depth + 1 < MAX_HELPER_DEPTH,
          workFolder: helperWorkFolder(input.name, helperThread.id),
        }),
        status: "queued",
      },
    });
    const helperRun = await tx.run.create({
      data: {
        spaceId: run.spaceId,
        botId: bot.id,
        threadId: helperThread.id,
        taskId: task.id,
        userId: run.userId,
        status: "queued",
        trigger: BACKGROUND_HELPER_TRIGGER,
        sourceMessageId: message.id,
        delegatedFromRunId: await outermostRunId(tx, run, runId),
        clientNonce,
        ...(modelProvider && modelId ? { modelProvider, modelId, modelPinned: true } : {}),
      },
      select: { id: true },
    });
    // The originating user's files remain available even when the parent never booted
    // its computer. Keep the input on the helper's own history for restart and approval resume.
    const sources = await tx.message.findMany({
      where: {
        threadId: thread.id,
        role: "user",
        OR: [
          { id: run.sourceMessageId ?? "" },
          { steeringMessages: { some: { runId, claimedAt: { not: null } } } },
        ],
      },
      select: { id: true, blocks: true },
      orderBy: { seq: "asc" },
    });
    const attachments = sources.flatMap((source) =>
      storedMessageBlocks(source).filter(
        (block) => block.kind === "file" || block.kind === "image",
      ),
    );
    if (attachments.length) {
      const input = await createThreadMessageInTransaction(tx, {
        threadId: helperThread.id,
        role: "user",
        authorUserId: run.userId,
        botId: bot.id,
        runId: helperRun.id,
        blocks: attachments,
        markUnread: false,
      });
      await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: helperThread.id,
        botId: bot.id,
        runId: helperRun.id,
        type: "thread.message.created",
        payload: { messageId: input.id, role: "user", blocks: attachments },
      });
    }
    return { eventSeq: event.seq, helperRunId: helperRun.id };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  if (committed === "full") {
    return {
      error: backgroundHelperLimitNote(MAX_HELPERS_PER_CHAT),
    };
  }
  if (!committed) return started;
  await deps.events.notify(thread.id, committed.eventSeq).catch((error) => {
    getLogger().error("background helper card notification", error);
  });
  await wakeRun(deps.jobs, committed.helperRunId);
  return started;
}

/**
 * Settle a finished helper's card and bring its result back to the chat that started it as a
 * new turn. Each helper returns once; a helper the user stopped only settles its card.
 */
export async function returnHelperOutcome(
  deps: HelperDeps,
  run: {
    id: string;
    spaceId: string;
    botId: string;
    userId: string;
    sourceMessageId?: string | null;
  },
  outcome: { status: "completed" | "failed" | "stopped"; text: string },
) {
  // The card's chat, read first so the lock below can come before any other row.
  const source = run.sourceMessageId
    ? await deps.prisma.message.findUnique({
        where: { id: run.sourceMessageId },
        select: { threadId: true },
      })
    : null;
  // Questions a helper asked sit in the chat its tree belongs to, which is not always its card's thread.
  const requestEvents: { threadId: string; eventSeq: number }[] = [];
  const committed = await deps.prisma.$transaction(async (tx) => {
    // Same lock order as clearing chat (and the cloud-agent wake): thread first.
    if (source) await tx.$queryRaw`SELECT id FROM threads WHERE id = ${source.threadId} FOR UPDATE`;
    const own = await tx.run.findUnique({
      where: { id: run.id },
      select: { threadId: true, createdAt: true, trigger: true },
    });
    if (own?.trigger === BACKGROUND_HELPER_TRIGGER) {
      // A helper that started helpers answers once they have all returned, in its last turn: an
      // earlier turn of its thread has nothing left to say, and no turn answers while another
      // is still working or a helper it started has yet to return.
      const turns = await tx.run.findMany({
        where: { threadId: own.threadId, trigger: BACKGROUND_HELPER_TRIGGER, id: { not: run.id } },
        select: { id: true, status: true, createdAt: true },
      });
      const superseded = turns.some(
        (turn) =>
          turn.createdAt > own.createdAt ||
          (turn.createdAt.getTime() === own.createdAt.getTime() && turn.id > run.id),
      );
      if (
        !superseded &&
        outcome.status === "completed" &&
        (turns.some((turn) => (ACTIVE_RUN_STATUSES as readonly string[]).includes(turn.status)) ||
          (await tx.run.count({
            where: {
              trigger: BACKGROUND_HELPER_TRIGGER,
              sourceMessage: { threadId: own.threadId },
              OR: [{ status: { in: [...ACTIVE_RUN_STATUSES] } }, { botOutcomeReturnedAt: null }],
            },
          })) > 0)
      )
        return null;
      if (superseded) {
        await tx.run.updateMany({
          where: {
            id: run.id,
            status: { in: ["completed", "failed", "cancelled"] },
            botOutcomeReturnedAt: null,
          },
          data: { botOutcomeReturnedAt: new Date() },
        });
        return null;
      }
    }
    const claimed = await tx.run.updateMany({
      where: {
        id: run.id,
        trigger: BACKGROUND_HELPER_TRIGGER,
        status: { in: ["completed", "failed", "cancelled"] },
        botOutcomeReturnedAt: null,
      },
      data: { botOutcomeReturnedAt: new Date() },
    });
    if (claimed.count !== 1 || !source || !run.sourceMessageId) return null;
    const card = await tx.message.findFirst({
      where: { id: run.sourceMessageId, threadId: source.threadId },
      select: {
        id: true,
        threadId: true,
        blocks: true,
        thread: {
          select: {
            helperBotId: true,
            group: {
              select: {
                archivedAt: true,
                members: { where: { botId: run.botId }, select: { botId: true } },
              },
            },
          },
        },
      },
    });
    const blocks = card ? storedMessageBlocks(card) : [];
    const helper = blocks.find((block): block is HelperBlock => block.kind === "subagent");
    // The chat was cleared since: nothing is left to settle or answer.
    if (!card || !helper) return null;
    if (outcome.status !== "completed") {
      const requests = await tx.message.findMany({
        where: { runId: run.id, role: "bot", thread: { spaceId: run.spaceId } },
        select: { id: true, threadId: true, blocks: true },
      });
      for (const request of requests) {
        const denied = changeMessageBlocks(request, (block) =>
          block.kind === "ask" && isApprovalAskBlock(block) && block.status !== "answered"
            ? { ...block, status: "answered" as const, answer: "deny" }
            : block,
        );
        if (!denied) continue;
        await tx.message.update({
          where: { id: request.id },
          data: { blocks: denied.stored },
        });
        const answered = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: request.threadId,
          botId: run.botId,
          type: "thread.message.updated",
          runId: run.id,
          allowCancelledRun: true,
          payload: { messageId: request.id, role: "bot", blocks: denied.blocks },
        });
        requestEvents.push({ threadId: request.threadId, eventSeq: answered.seq });
      }
    }
    const result =
      outcome.status === "stopped"
        ? STOPPED_HELPER_RESULT
        : helperResultText(outcome.text.trim() || "done.", undefined, RESULT_LIMIT);
    const settled: HelperBlock = {
      ...helper,
      status: outcome.status === "completed" ? "completed" : "failed",
      progress: undefined,
      result,
    };
    const next = changeMessageBlocks(card, (block) => (block === helper ? settled : block));
    if (!next) return null;
    const nextBlocks = next.blocks;
    await tx.message.update({ where: { id: card.id }, data: { blocks: next.stored } });
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: card.threadId,
      botId: run.botId,
      type: "thread.message.updated",
      payload: { messageId: card.id, role: "bot", blocks: nextBlocks },
    });
    if (
      outcome.status === "stopped" ||
      (card.thread?.group && (card.thread.group.archivedAt || !card.thread.group.members.length))
    )
      return { threadId: card.threadId, eventSeq: event.seq };
    // Like the cloud-agent wake: only for a person still in the space and a bot still active
    // there. In a shared space that bot may be another member's; the turn runs as this person.
    const [member, bot] = await Promise.all([
      tx.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: run.spaceId, userId: run.userId } },
        select: { id: true },
      }),
      tx.bot.findFirst({
        where: { id: run.botId, spaceId: run.spaceId, archivedAt: null },
        select: { id: true },
      }),
    ]);
    if (!member || !bot) return { threadId: card.threadId, eventSeq: event.seq };
    // A helper's own thread has nobody to read a result: the helper that started this one takes
    // it as another turn, and answers its own card when that turn ends. A card already settled
    // (stopped, or failed) has nobody waiting.
    const owner = card.thread?.helperBotId
      ? await tx.run.findFirst({
          where: { threadId: card.threadId, trigger: BACKGROUND_HELPER_TRIGGER },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            sourceMessageId: true,
            modelProvider: true,
            modelId: true,
            modelPinned: true,
            sourceMessage: { select: { id: true, blocks: true } },
          },
        })
      : null;
    if (card.thread?.helperBotId) {
      const ownerCard = owner?.sourceMessage
        ? storedMessageBlocks(owner.sourceMessage).find(
            (block): block is HelperBlock => block.kind === "subagent",
          )
        : undefined;
      if (!owner?.sourceMessageId || ownerCard?.status !== "running")
        return { threadId: card.threadId, eventSeq: event.seq };
    }
    const task = await tx.task.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: card.threadId,
        userId: run.userId,
        prompt: resultPrompt(helper.name, outcome.status, result, owner ? "parent" : "user"),
        status: "queued",
      },
    });
    const wake = await tx.run.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: card.threadId,
        taskId: task.id,
        userId: run.userId,
        status: "queued",
        trigger: owner ? BACKGROUND_HELPER_TRIGGER : HELPER_RESULT_TRIGGER,
        delegatedFromRunId: owner?.id ?? run.id,
        ...(owner
          ? {
              sourceMessageId: owner.sourceMessageId,
              ...(owner.modelPinned && owner.modelProvider && owner.modelId
                ? {
                    modelProvider: owner.modelProvider,
                    modelId: owner.modelId,
                    modelPinned: true,
                  }
                : {}),
            }
          : {}),
        clientNonce: `helper-result:${run.id}`,
      },
      select: { id: true },
    });
    const replies = await tx.message.findMany({
      where: { runId: run.id, role: "bot" },
      orderBy: { seq: "asc" },
      select: { id: true, blocks: true },
    });
    const attachments = replies.flatMap((reply) =>
      storedMessageBlocks(reply).filter((block) => block.kind === "file" || block.kind === "image"),
    );
    let eventSeq = event.seq;
    if (attachments.length) {
      const attached = await createThreadMessageInTransaction(tx, {
        threadId: card.threadId,
        botId: run.botId,
        role: "bot",
        runId: wake.id,
        blocks: attachments,
      });
      eventSeq = (
        await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: card.threadId,
          botId: run.botId,
          runId: wake.id,
          type: "thread.message.created",
          payload: { messageId: attached.id, role: "bot", blocks: attachments },
        })
      ).seq;
    }
    return { threadId: card.threadId, eventSeq, wakeRunId: wake.id };
  }, THREAD_LOCK_TRANSACTION_OPTIONS);
  for (const request of requestEvents) {
    await deps.events.notify(request.threadId, request.eventSeq).catch((error) => {
      getLogger().error("background helper request notification", error);
    });
  }
  if (!committed) return;
  await deps.events.notify(committed.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("background helper card notification", error);
  });
  if (committed.wakeRunId && deps.jobs) await wakeRun(deps.jobs, committed.wakeRunId);
}
