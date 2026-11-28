import { parseTicketRef } from "@rakazo/contracts";
import { displayName, redactSecrets, TAKEOVER_COMPUTER_PENDING_STATE } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { MAX_APPROVAL_DETAIL_LENGTH, truncate } from "../../approvals/approval-ask.js";
import { scheduleComputerSleep } from "../../computers/computer-idle.js";
import { holdComputerExecutionLeaseForTakeover } from "../../computers/computer-lifecycle.js";
import { reportBotMessageWait } from "../../messaging/bot-messages.js";
import { scheduleRunSecretsExpiry } from "../../secrets/run-secrets-expiry.js";
import type { RunContext } from "../assembly/run-context.js";
import { persistTurnCheckpoint } from "../assembly/run-context.js";
import { publishMessage } from "../assembly/run-messages.js";
import { enqueueSteeringContinuation, renewRunLease } from "../lifecycle/run-lifecycle.js";
import { notifyRun } from "../lifecycle/run-notifications.js";
import {
  canPublishDurableNarration,
  publishInterimMessage,
  publishMidTurnNarration,
  publishNarrationBeforeAsk,
} from "../lifecycle/run-progress.js";
import { clampUserProgressMessage } from "../lifecycle/user-progress.js";
import { wakeRun } from "../wakeups/wake-run.js";
import type { RuntimeEvent } from "./run-turn.js";

/**
 * The board ticket a single ask is about. An explicit ticketRef is kept when it is a valid ref.
 * Without one, the ask links a ticket only when its text names exactly one ticket of the Space's
 * board that exists; with zero or several named tickets it links none, never guessing.
 */
export async function singleAskTicketRef(
  prisma: PrismaClient,
  spaceId: string,
  event: { ticketRef?: string },
  text: string,
): Promise<string | undefined> {
  if (event.ticketRef !== undefined) {
    const explicit = parseTicketRef(event.ticketRef);
    return explicit ? `${explicit.prefix}-${explicit.number}` : undefined;
  }
  // Most asks name no ticket, so the board is read only when the text holds something ref-shaped.
  if (!/(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9]*-[1-9][0-9]*(?![0-9])/.test(text)) return undefined;
  const board = await prisma.board.findFirst({
    where: { spaceId },
    select: { id: true, ticketPrefix: true },
  });
  if (!board) return undefined;
  const prefix = board.ticketPrefix.toUpperCase();
  const named = new Set(
    [...text.matchAll(new RegExp(`(?<![A-Za-z0-9_])${prefix}-([1-9][0-9]*)(?![0-9])`, "gi"))].map(
      (match) => Number(match[1]),
    ),
  );
  const [number] = [...named];
  if (named.size !== 1 || number === undefined) return undefined;
  const ticket = await prisma.ticket.findFirst({
    where: { spaceId, boardId: board.id, number },
    select: { id: true },
  });
  return ticket ? `${prefix}-${number}` : undefined;
}

export async function pauseForAnswer(ctx: RunContext, event: RuntimeEvent<"ask">) {
  const { deps, run, runId, bot, thread, workerId, fence } = ctx;
  if (!(await renewRunLease(deps, runId, workerId, fence))) return;
  await publishNarrationBeforeAsk(ctx);
  const safeText = redactSecrets(event.text, ctx.secrets);
  // The bot's own words under its question, capped like an approval card's detail.
  const safeDetail = event.detail
    ? truncate(redactSecrets(event.detail, ctx.secrets), MAX_APPROVAL_DETAIL_LENGTH)
    : event.detail;
  const safeActions = event.actions?.map((action) => ({
    id: action.id,
    label: redactSecrets(action.label, ctx.secrets),
    ...(action.description ? { description: redactSecrets(action.description, ctx.secrets) } : {}),
    ...(action.recommended ? { recommended: true } : {}),
  }));
  // Batch items: question, detail and choice text are redacted; ids and ticket refs stay.
  const safeItems = event.items?.map((item) => ({
    id: item.id,
    question: redactSecrets(item.question, ctx.secrets),
    ...(item.detail ? { detail: redactSecrets(item.detail, ctx.secrets) } : {}),
    ...(item.ticketRef ? { ticketRef: item.ticketRef } : {}),
    ...(item.actions
      ? {
          actions: item.actions.map((action) => ({
            id: action.id,
            label: redactSecrets(action.label, ctx.secrets),
            ...(action.description
              ? { description: redactSecrets(action.description, ctx.secrets) }
              : {}),
            ...(action.recommended ? { recommended: true } : {}),
          })),
        }
      : {}),
  }));
  // A single ask about a board ticket carries its ref, so answering it resolves the ticket too.
  const ticketRef = event.items
    ? undefined
    : await singleAskTicketRef(deps.prisma, run.spaceId, event, `${safeText}\n${safeDetail ?? ""}`);
  await ctx.computer.checkpoint.flush();
  await persistTurnCheckpoint(ctx, event.executionId);
  await ctx.settleRunningHelpers();
  const paused = await deps.events.pauseRunForInput({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    runId,
    attemptId: ctx.attempt.id,
    leaseOwner: workerId,
    leaseFence: fence,
    onPaused: scheduleRunSecretsExpiry(deps.jobs, runId),
    blocks: [
      {
        kind: "ask",
        text: safeText,
        detail: safeDetail,
        // A runtime ask's detail is prose the bot wrote, never tool arguments.
        ...(safeDetail ? { detailFormat: "text" as const } : {}),
        ...(ticketRef ? { ticketRef } : {}),
        status: "pending",
        actions: safeActions,
        ...(safeItems ? { items: safeItems } : {}),
      },
    ],
    // Keep unredacted labels on the run for resume; message blocks stay redacted.
    offeredActions: event.actions,
    offeredItems: event.items,
  });
  if (!paused) return;
  await enqueueSteeringContinuation(deps, paused.continuationRunId);
  await reportBotMessageWait(deps, run, bot, safeText, ctx.attempt.id);
  await notifyRun(deps, run, {
    kind: "help",
    title: `${displayName(bot.name, "Bot")} needs an answer`,
    body: safeText,
    botId: bot.id,
    threadId: thread.id,
  });
}

export async function pauseForTakeover(ctx: RunContext, event: RuntimeEvent<"takeover">) {
  const { deps, run, runId, bot, thread, workerId, fence } = ctx;
  const { reply } = ctx.state;
  if (!(await renewRunLease(deps, runId, workerId, fence))) return;
  // The user takes over the computer's screen, so it must be up before the run waits.
  await ctx.computer.get("takeover");
  const safeReason = redactSecrets(event.reason, ctx.secrets);
  // Publish pending narration as tagged mid-turn progress so reconciliation
  // does not treat pre-takeover text as the delegated final result.
  await publishMidTurnNarration(ctx);
  if (reply.assembled.trim()) {
    const narration = clampUserProgressMessage(redactSecrets(reply.assembled, ctx.secrets));
    if (narration && canPublishDurableNarration(ctx)) {
      await publishInterimMessage(ctx, narration);
    } else if (narration) {
      reply.discardedMidTurnNarration = true;
      reply.lastDiscardedMidTurnNarration = narration;
    }
    reply.assembled = "";
    reply.hasStreamedText = false;
    reply.pendingProgress = "";
  }
  // Give the user a full idle period to answer before the computer may suspend.
  scheduleComputerSleep(deps.jobs, ctx.computer.stored.id);
  await publishMessage(
    deps,
    run,
    "bot",
    [{ kind: "computer", state: TAKEOVER_COMPUTER_PENDING_STATE, text: safeReason }],
    true,
  );
  await ctx.computer.checkpoint.flush();
  if (!(await holdComputerExecutionLeaseForTakeover(deps.prisma, ctx.computer.lease))) {
    throw new Error("Computer lease expired before takeover");
  }
  await persistTurnCheckpoint(ctx, event.executionId);
  await ctx.settleRunningHelpers();
  const paused = await deps.events.pauseRunForTakeover({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    runId,
    attemptId: ctx.attempt.id,
    leaseOwner: workerId,
    leaseFence: fence,
    reason: safeReason,
  });
  if (!paused) return;
  if (typeof paused === "object") {
    await wakeRun(deps.jobs, paused.continuationRunId);
    return;
  }
  ctx.state.lease.retainComputer = true;
  await notifyRun(deps, run, {
    kind: "takeover",
    title: `${displayName(bot.name, "Bot")} needs you on the screen`,
    body: safeReason,
    botId: bot.id,
    threadId: thread.id,
  });
}
