import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { hasPendingTicketDecision, parseTicketRef } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, isApprovalAskBlock } from "@rakazo/core";
import { ensureBoard, readTicketDecision, toDecisionJsonInput } from "../artifacts/board.js";
import { createBoardEvents } from "../artifacts/board-live.js";
import type { Prisma, PrismaClient } from "../database/client.js";
import { THREAD_LOCK_TRANSACTION_OPTIONS } from "../database/transaction-retry.js";
import { deleteRunSecretsInTransaction } from "../runs/run-secrets.js";
import { RUN_TURN_CHECKPOINT_KIND } from "../runs/run-turn-checkpoint.js";
import { publishSpaceChange } from "../spaces/space-changes.js";
import { notifyRealtime } from "./event-stream.js";
import { appendEventInTransaction } from "./events.js";
import { readMessageBlocks } from "./message-blocks.js";

/** A board ticket a chat answer settles: its ref and the answer the user gave. */
export interface TicketChatAnswer {
  ticketRef: string;
  answer: string;
}

/**
 * Cancels a waiting run whose pending questions are answered by something other than the run:
 * the run, its checkpoint effects and secrets, its attempt and its task go, and every question in
 * `questions` (already answered in `blocks`) is written back with a message update. Null when the
 * run was no longer waiting.
 */
export async function cancelWaitingRunWithAnswersInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    threadId: string;
    botId: string;
    runId: string;
    userId: string;
    taskId: string;
    questions: Array<{ id: string; blocks: MessageBlock[] }>;
  },
): Promise<{ threadId: string; seq: number } | null> {
  const now = new Date();
  const retired = await tx.run.updateMany({
    where: {
      id: input.runId,
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      status: "waiting_input",
    },
    data: {
      status: "cancelled",
      completedAt: now,
      checkpoint: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  if (retired.count !== 1) return null;
  await tx.externalEffect.deleteMany({
    where: { runId: input.runId, kind: RUN_TURN_CHECKPOINT_KIND, status: RUN_TURN_CHECKPOINT_KIND },
  });
  await deleteRunSecretsInTransaction(tx, [
    { id: input.runId, userId: input.userId, spaceId: input.spaceId },
  ]);
  await tx.attempt.updateMany({
    where: { runId: input.runId, status: "waiting_input" },
    data: { status: "cancelled", finishedAt: now },
  });
  await tx.task.updateMany({
    where: { id: input.taskId, runs: { none: { status: { in: [...ACTIVE_RUN_STATUSES] } } } },
    data: { status: "cancelled" },
  });
  for (const question of input.questions) {
    await tx.message.update({ where: { id: question.id }, data: { blocks: question.blocks } });
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      runId: input.runId,
      type: "thread.message.updated",
      allowCancelledRun: true,
      payload: { messageId: question.id, role: "bot", blocks: question.blocks },
    });
  }
  const cancelled = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: input.botId,
    runId: input.runId,
    type: "run.cancelled",
    payload: {},
  });
  return { threadId: cancelled.threadId, seq: cancelled.seq };
}

/**
 * The blocks of a waiting run whose only pending questions are single, non-secret, non-approval
 * asks about `ticketRef`, answered with `answer`. Null when the run holds anything else pending
 * (a secret, an approval, a batch or a question about another subject) or a row it cannot read
 * whole, since cancelling the run would answer those too.
 */
function retireTicketQuestions(
  messages: Array<{ id: string; blocks: unknown }>,
  ticketRef: string,
  answer: string,
): Array<{ id: string; blocks: MessageBlock[] }> | null {
  const questions: Array<{ id: string; blocks: MessageBlock[] }> = [];
  let matched = 0;
  for (const message of messages) {
    const { blocks, intact } = readMessageBlocks(message);
    if (!intact) return null;
    const pending = blocks.filter((block) => block.kind === "ask" && block.status !== "answered");
    for (const block of pending) {
      if (block.kind !== "ask") continue;
      // Credentials and external-effect approvals are never answered by a ticket's settlement.
      if (
        block.input === "secret" ||
        block.approvalEffectId ||
        isApprovalAskBlock(block) ||
        block.items !== undefined
      )
        return null;
      if (block.ticketRef?.trim().toLowerCase() !== ticketRef) return null;
      matched += 1;
    }
    if (pending.length === 0) continue;
    questions.push({
      id: message.id,
      blocks: blocks.map((block) =>
        block.kind === "ask" && block.status !== "answered"
          ? { ...block, status: "answered" as const, answer }
          : block,
      ),
    });
  }
  return matched > 0 ? questions : null;
}

/**
 * Retires the waiting chat questions about a board ticket, once the ticket is decided, closed or
 * cleared: each run whose only pending question is about the ticket is cancelled with that
 * question answered by `answer`. Secret, approval and batch cards are never touched, and a run
 * with any other pending question is left alone. Call it after the ticket change commits; each
 * run is retired in its own thread-locked transaction. Returns how many runs were retired.
 */
export async function retireWaitingQuestionsForTicket(
  prisma: PrismaClient,
  input: { spaceId: string; ticketRef: string; answer: string },
  realtime?: RealtimeFanout,
): Promise<number> {
  const ticketRef = input.ticketRef.trim().toLowerCase();
  const answer = input.answer.trim();
  if (!ticketRef || !answer) return 0;
  const runs = await prisma.run.findMany({
    where: { spaceId: input.spaceId, status: "waiting_input" },
    select: { id: true, threadId: true, botId: true, userId: true, taskId: true },
  });
  let retired = 0;
  for (const run of runs) {
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
      const current = await tx.run.findFirst({
        where: {
          id: run.id,
          spaceId: input.spaceId,
          threadId: run.threadId,
          status: "waiting_input",
        },
        select: { id: true },
      });
      if (!current) return null;
      const messages = await tx.message.findMany({
        where: { threadId: run.threadId, runId: run.id, role: "bot" },
        select: { id: true, blocks: true },
      });
      const questions = retireTicketQuestions(messages, ticketRef, answer);
      if (!questions) return null;
      return cancelWaitingRunWithAnswersInTransaction(tx, {
        spaceId: input.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        runId: run.id,
        userId: run.userId,
        taskId: run.taskId,
        questions,
      });
    }, THREAD_LOCK_TRANSACTION_OPTIONS);
    if (!outcome) continue;
    retired += 1;
    await notifyRealtime(realtime, outcome.threadId, outcome.seq);
    await publishSpaceChange(realtime, input.spaceId, "runs");
  }
  return retired;
}

/**
 * Answers the board tickets a chat answer settled: each ticket's pending decision takes the answer,
 * and a blocked or review ticket moves back to todo. Runs after the answer commits, one short
 * ticket transaction per ticket, so no thread lock is held while a ticket is locked. The ticket's
 * bot is not woken; the chat run is already resumed with this answer.
 */
export async function resolveTicketDecisionsFromChatAnswer(
  prisma: PrismaClient,
  input: { spaceId: string; answeredByUserId: string; answers: readonly TicketChatAnswer[] },
  realtime?: RealtimeFanout,
): Promise<void> {
  const board = await ensureBoard(prisma, input.spaceId);
  for (const { ticketRef, answer } of input.answers) {
    const parsed = parseTicketRef(ticketRef, board.ticketPrefix);
    if (!parsed) continue;
    const found = await prisma.ticket.findFirst({
      where: { spaceId: input.spaceId, boardId: board.id, number: parsed.number },
      select: { id: true },
    });
    if (!found) continue;
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${found.id} FOR UPDATE`;
      const current = await tx.ticket.findFirst({
        where: { id: found.id, spaceId: input.spaceId },
      });
      if (!current) return null;
      const decision = readTicketDecision(current);
      if (!decision || !hasPendingTicketDecision({ decision })) return null;
      const now = new Date();
      const row = await tx.ticket.update({
        where: { id: current.id },
        data: {
          decision: toDecisionJsonInput({ ...decision, answer, answeredAt: now.toISOString() }),
          ...(current.status === "blocked" || current.status === "review"
            ? { status: "todo", completedAt: null, archivedAt: null }
            : {}),
        },
      });
      await tx.ticketComment.create({
        data: {
          ticketId: current.id,
          spaceId: input.spaceId,
          authorBotId: null,
          authorUserId: input.answeredByUserId,
          body: `> ${decision.question}\n\n${answer}`,
        },
      });
      return row;
    });
    if (updated)
      await createBoardEvents(realtime).notify(input.spaceId, {
        boardId: board.id,
        ticketId: updated.id,
      });
  }
}
