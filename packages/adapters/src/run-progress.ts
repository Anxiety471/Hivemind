import type { MessageBlock } from "@rakazo/contracts";
import type { ToolStepOutcome } from "@rakazo/core";
import {
  appendTextSegment,
  appendToolCallSegment,
  createStreamingRedactor,
  endsSentence,
  isBackgroundRunTrigger,
  isConversationalRun,
  noteLastToolStep,
  redactSecrets,
  redactSecretsAfter,
  withToolStepOutcomes,
} from "@rakazo/core";
import type { Run } from "@rakazo/db";
import { RunHistoryWriteError, storedMessageBlocks } from "@rakazo/db";
import type { ExecutorDeps } from "./executor-deps.js";
import { IMAGE_RETURNING_COMPUTER_TOOLS } from "./model-vision.js";
import type { ReplyState, RunContext, ThinkingSegmentState } from "./run-context.js";
import { publishMessage } from "./run-messages.js";
import {
  messageBlocksText,
  runAllowsSilentEmpty,
  runPromotesMidTurnNarration,
} from "./run-replies.prompt.js";
import { PAGE_BROWSER_TOOL_NAMES } from "./run-tool-selection.js";
import { couldBecomeNoResponse, isExactNoResponse, isPlaceholderText } from "./silent-reply.js";
import { USER_COMPUTER_SCREEN_TOOLS } from "./user-computer-tools.js";
import {
  clampUserProgressMessage,
  extractNarrationText,
  isUserProgressClientNonce,
  midTurnProgressBudgetAllows,
  narrationStatusLine,
  USER_PROGRESS_MESSAGE_MAX_LENGTH,
  userProgressClientNonce,
} from "./user-progress.js";

/** A fresh reply that knows the progress messages earlier attempts of this run posted. */
export async function createReplyState(
  deps: ExecutorDeps,
  run: Run,
  secrets: string[],
): Promise<ReplyState> {
  const reply: ReplyState = {
    assembled: "",
    currentTextSegment: "",
    messageSegments: [],
    publishedTerminalSubagent: false,
    publishedMidTurnUserMessage: false,
    discardedMidTurnNarration: false,
    lastDiscardedMidTurnNarration: "",
    explicitNoResponse: false,
    assistantTurnText: "",
    midTurnUserTexts: [],
    midTurnProgressCount: 0,
    turnStartedAtMs: run.startedAt?.getTime() ?? Date.now(),
    progressBudgetStart: 0,
    steeringReplyPending: false,
    computerTaskStarted: false,
    steeringResets: 0,
    lastSteeringResetAt: Number.NEGATIVE_INFINITY,
    workingNotes: [],
    textSinceLastStep: "",
    narrationSoFar: "",
    narrationStatusShowing: false,
    pendingToolNames: [],
    toolCalls: [],
    toolOutcomes: new Map(),
    toolStepCalls: new Map(),
    keptResultChars: 0,
    pendingProgress: "",
    lastProgressAt: 0,
    hasStreamedText: false,
    assistantTurnBreakPending: false,
    thinking: null,
    thinkingRedactor: createStreamingRedactor(secrets),
    redactor: createStreamingRedactor(secrets),
  };
  const priorProgress = await deps.prisma.message.findMany({
    where: { runId: run.id, role: "bot" },
    orderBy: { seq: "asc" },
    select: { id: true, blocks: true, clientNonce: true },
  });
  for (const message of priorProgress) {
    if (!isUserProgressClientNonce(message.clientNonce)) continue;
    const text = messageBlocksText(storedMessageBlocks(message)).trim();
    if (!text) continue;
    reply.midTurnUserTexts.push(text);
    reply.publishedMidTurnUserMessage = true;
    reply.midTurnProgressCount += 1;
  }
  return reply;
}

export function recordExplicitNoResponse(reply: ReplyState, text: string) {
  reply.explicitNoResponse ||= isExactNoResponse(text) || /\bNO_RESPONSE\b/.test(text);
}

/** Durable interim messages only on genuinely long turns, capped per run. */
export function canPublishDurableProgress(reply: ReplyState) {
  return (
    reply.steeringReplyPending ||
    midTurnProgressBudgetAllows(progressSinceBudgetStart(reply), Date.now() - reply.turnStartedAtMs)
  );
}

const BROWSER_AND_DESKTOP_TOOLS = new Set([
  ...IMAGE_RETURNING_COMPUTER_TOOLS,
  ...PAGE_BROWSER_TOOL_NAMES,
  ...USER_COMPUTER_SCREEN_TOOLS,
]);

export function noteComputerTaskStep(reply: ReplyState, toolName: string) {
  if (BROWSER_AND_DESKTOP_TOOLS.has(toolName)) reply.computerTaskStarted = true;
}

/**
 * Browser and desktop tasks often take minutes, so the run's first interim message may tell
 * the person so at once. Runs nobody is waiting on keep the fresh-turn rule.
 */
export function canPostLongTaskHeadsUp(ctx: RunContext) {
  const { reply } = ctx.state;
  return (
    reply.computerTaskStarted &&
    reply.midTurnProgressCount === 0 &&
    isConversationalRun(ctx.run.trigger) &&
    !runAllowsSilentEmpty(ctx.run.trigger)
  );
}

export function progressSinceBudgetStart(reply: ReplyState) {
  return reply.midTurnProgressCount - reply.progressBudgetStart;
}

/** The next interim message's nonce; it uses up the allowance for answering the person. */
function nextProgressNonce(ctx: RunContext) {
  const { reply } = ctx.state;
  reply.steeringReplyPending = false;
  return userProgressClientNonce(ctx.run.id, reply.midTurnProgressCount++);
}

/**
 * Posts an interim message. A chat app gets a run's messages when the run ends, so a 1:1 run it
 * started sends this one on at once. A group run posts once, when it ends.
 */
export async function publishInterimMessage(ctx: RunContext, text: string, markUnread?: boolean) {
  const { deps, run } = ctx;
  const { reply } = ctx.state;
  await publishMessage(
    deps,
    run,
    "bot",
    [{ kind: "text", text }],
    markUnread,
    nextProgressNonce(ctx),
  );
  reply.midTurnUserTexts.push(text);
  reply.publishedMidTurnUserMessage = true;
  if (run.trigger === "messaging" && !ctx.source.channelId) {
    // Sent from here while the turn carries on; its rows' backup jobs cover a failed send.
    const delivery = deps.messagingDelivery;
    void delivery?.deliverRun(run.id, { progress: true }).catch((error) => {
      delivery.reportFailure("messaging progress delivery error", error);
    });
  }
}

/** Whether text written before a step may be posted as an interim message at all. */
export function narrationBecomesMessages(ctx: RunContext) {
  return ctx.replyMode === "chat" && runPromotesMidTurnNarration(ctx.run.trigger);
}

export function canPublishDurableNarration(ctx: RunContext) {
  return narrationBecomesMessages(ctx) && canPublishDurableProgress(ctx.state.reply);
}

export function flushPendingTools(reply: ReplyState) {
  if (reply.currentTextSegment) {
    reply.messageSegments = appendTextSegment(reply.messageSegments, reply.currentTextSegment);
    reply.currentTextSegment = "";
  }
  for (const name of reply.pendingToolNames) {
    reply.messageSegments = appendToolCallSegment(reply.messageSegments, name);
  }
  reply.pendingToolNames = [];
}

/**
 * The reply's steps with how each call ended. Calls with no result yet count as `unfinished`
 * when given (a stopped run), otherwise they carry no outcome.
 */
export function withReplyToolOutcomes(
  reply: ReplyState,
  unfinished?: ToolStepOutcome,
): MessageBlock[] {
  return withToolStepOutcomes(
    reply.messageSegments,
    reply.toolCalls.map(({ label, executionId, tool }) => ({
      label,
      outcome: reply.toolOutcomes.get(executionId) ?? unfinished,
      tool,
      call: reply.toolStepCalls.get(executionId),
    })),
  );
}

export function tryFlushPendingTools(reply: ReplyState) {
  if (reply.pendingToolNames.length > 0 && endsSentence(reply.currentTextSegment))
    flushPendingTools(reply);
}

/**
 * A member a group message named nobody for may answer with the silence sentinel, so what it
 * has written stays unseen while that is still possible. Once the text turns into a reply it
 * all shows.
 */
export function progressHeldForSilence(ctx: RunContext) {
  const { reply } = ctx.state;
  return !reply.hasStreamedText && mayBeSilentEnding(ctx, reply.pendingProgress);
}

/** Text a member a group message named nobody for may still turn into its silent ending. */
export function mayBeSilentEnding(ctx: Pick<RunContext, "groupReplyOptional">, text: string) {
  return ctx.groupReplyOptional && (couldBecomeNoResponse(text) || isPlaceholderText(text));
}

export async function flushProgress(ctx: RunContext) {
  const { deps, run, runId, bot, thread } = ctx;
  const { reply } = ctx.state;
  // Routines may finish silently. Do not leak narration or a partial silence
  // sentinel before the final outcome is known.
  if (
    ctx.scripted ||
    !reply.pendingProgress ||
    run.trigger === "routine" ||
    isBackgroundRunTrigger(run.trigger) ||
    progressHeldForSilence(ctx)
  )
    return;
  await deps.events.append({
    spaceId: run.spaceId,
    threadId: thread.id,
    botId: bot.id,
    type: "thread.progress",
    runId,
    // The first flush replaces the "working…" placeholder outright — a delta here
    // would otherwise get appended straight onto it with no separator.
    payload: reply.hasStreamedText
      ? { delta: reply.pendingProgress, streaming: true }
      : { text: reply.pendingProgress, streaming: true },
  });
  reply.hasStreamedText = true;
  reply.pendingProgress = "";
  reply.lastProgressAt = Date.now();
}

/** The first non-empty reasoning lines a block keeps; later ones are dropped, not rolled. */
export const THINKING_BLOCK_MAX_LINES = 8;
/** A kept line is clamped to this many characters, its cut end marked with an ellipsis. */
export const THINKING_LINE_MAX_CHARS = 600;
/** The whole block's text budget, ~5 KB; 8 clamped lines always stay under it. */
export const THINKING_BLOCK_MAX_CHARS = 4_800;
/** The cadence of a live reasoning snapshot, the same one the reply text streams at. */
export const THINKING_LIVE_FLUSH_MS = 250;

/**
 * Reasoning is transcript content for a person watching the bot, like its narration: routine,
 * background and scripted work keep it out of the thread.
 */
export function thinkingCaptureEnabled(ctx: Pick<RunContext, "scripted" | "run">) {
  return !ctx.scripted && ctx.run.trigger !== "routine" && !isBackgroundRunTrigger(ctx.run.trigger);
}

/** The first lines a reasoning block keeps: blanks skipped, each clamped, later lines dropped. */
export function thinkingBlockLines(text: string): string[] {
  const lines: string[] = [];
  let kept = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const room = Math.min(THINKING_LINE_MAX_CHARS, THINKING_BLOCK_MAX_CHARS - kept);
    if (room <= 0) break;
    const clamped = line.length <= room ? line : `${line.slice(0, room - 1)}…`;
    lines.push(clamped);
    kept += clamped.length;
    if (lines.length >= THINKING_BLOCK_MAX_LINES) break;
  }
  return lines;
}

/** Appends what the redactor let through, without keeping more than the block's budget. */
export function appendThinkingText(segment: ThinkingSegmentState, text: string) {
  const room = THINKING_BLOCK_MAX_CHARS - segment.text.length;
  if (room > 0 && text) segment.text += text.slice(0, room);
}

/** Starts a reasoning segment when the provider begins one; text and steps before it go first. */
export async function openThinkingSegment(ctx: RunContext) {
  const { reply } = ctx.state;
  if (reply.thinking || !thinkingCaptureEnabled(ctx)) return;
  // What the bot streamed and did before it started reasoning comes first in its message.
  flushPendingTools(reply);
  await flushProgress(ctx);
  reply.lastThinking = undefined;
  reply.thinking = { startedAt: Date.now(), text: "", lastFlushedAt: 0 };
}

/**
 * Adds reasoning the provider streamed, publishing a live snapshot at the reply text's cadence.
 * The provider can report the end of its reasoning before its buffered deltas arrive here, so a
 * delta with no open segment reopens the reasoning block it extends: one stream stays one card.
 */
export async function streamThinking(ctx: RunContext, text: string) {
  if (!text || !thinkingCaptureEnabled(ctx)) return;
  const { reply } = ctx.state;
  reply.thinking ??= reopenedThinkingSegment(reply) ?? {
    startedAt: Date.now(),
    text: "",
    lastFlushedAt: 0,
  };
  appendThinkingText(reply.thinking, reply.thinkingRedactor.push(text));
  const now = Date.now();
  if (now - reply.thinking.lastFlushedAt < THINKING_LIVE_FLUSH_MS) return;
  reply.thinking.lastFlushedAt = now;
  await publishThinkingSnapshot(ctx, {
    segment: reply.messageSegments.filter((block) => block.kind === "thinking").length,
    durationMs: now - reply.thinking.startedAt,
    lines: thinkingBlockLines(reply.thinking.text),
  });
}

/**
 * The reasoning segment a late delta continues: the reply's newest block, when it is reasoning
 * and nothing has been written after it. Its block comes back out so closing can put that same
 * segment's block in the same place, keeping the start it had so its duration stays honest.
 */
function reopenedThinkingSegment(reply: ReplyState): ThinkingSegmentState | undefined {
  const last = reply.messageSegments.at(-1);
  const closed = reply.lastThinking;
  if (last?.kind !== "thinking" || !closed) return undefined;
  reply.messageSegments.pop();
  reply.lastThinking = undefined;
  // 0 admits the next live snapshot at once, so the reopened card shows both halves.
  return { startedAt: closed.startedAt, text: closed.text, lastFlushedAt: 0 };
}

/**
 * Ends the open reasoning segment: keeps its block in the reply, before whatever ended it, and
 * publishes its final live snapshot. A segment left empty by redaction keeps no block at all.
 */
export async function closeThinkingSegment(ctx: RunContext) {
  const { reply } = ctx.state;
  const segment = reply.thinking;
  if (!segment) return;
  reply.thinking = null;
  appendThinkingText(segment, reply.thinkingRedactor.finish());
  const lines = thinkingBlockLines(segment.text);
  if (lines.length === 0) {
    reply.lastThinking = undefined;
    return;
  }
  const durationMs = Math.max(0, Math.round(Date.now() - segment.startedAt));
  const segmentIndex = reply.messageSegments.filter((block) => block.kind === "thinking").length;
  reply.messageSegments.push({ kind: "thinking", durationMs, lines });
  // The provider can still deliver deltas it buffered before its end marker; keep the exact
  // text so one split word rejoins whole if they come.
  reply.lastThinking = { startedAt: segment.startedAt, text: segment.text };
  await publishThinkingSnapshot(ctx, { segment: segmentIndex, durationMs, lines });
}

/**
 * Publishes the reasoning a message holds so far as a snapshot of its segment, so a repeated
 * delivery lands on the same block instead of growing the message.
 */
async function publishThinkingSnapshot(
  ctx: RunContext,
  snapshot: { segment: number; durationMs: number; lines: string[] },
) {
  const { deps, run, runId, bot, thread } = ctx;
  if (snapshot.lines.length === 0) return;
  try {
    await deps.events.append({
      spaceId: run.spaceId,
      threadId: thread.id,
      botId: bot.id,
      type: "thread.thinking",
      runId,
      lease: { owner: ctx.workerId, fence: ctx.fence },
      payload: {
        segment: snapshot.segment,
        durationMs: Math.max(0, Math.round(snapshot.durationMs)),
        lines: snapshot.lines,
      },
    });
  } catch (error) {
    // A superseded attempt still finishes its turn; its live reasoning must never override
    // the attempt that owns the run now.
    if (!(error instanceof RunHistoryWriteError)) throw error;
  }
}

/**
 * Text the bot wrote before a step. It is posted as an interim message when the budget allows
 * and it fits; otherwise it is a note on that step, kept out of the reply. Returns the note so
 * the caller can show it as the working line.
 */
export async function publishMidTurnNarration(ctx: RunContext, beforeConnectCard = false) {
  const { run } = ctx;
  const { reply } = ctx.state;
  const extracted = extractNarrationText(reply.messageSegments, reply.currentTextSegment);
  reply.messageSegments = extracted.remaining;
  reply.currentTextSegment = "";
  const text = redactSecretsAfter(reply.narrationSoFar, extracted.text, ctx.secrets).trim();
  reply.narrationSoFar += extracted.text;
  if (!text) return undefined;
  reply.assembled = "";
  reply.hasStreamedText = false;
  reply.pendingProgress = "";
  // Text the redactor still holds back belongs to the text just taken out.
  reply.redactor.skip();
  const promotes = runPromotesMidTurnNarration(run.trigger);
  if (
    text.length <= USER_PROGRESS_MESSAGE_MAX_LENGTH &&
    (canPublishDurableNarration(ctx) || (beforeConnectCard && narrationBecomesMessages(ctx)))
  ) {
    reply.workingNotes.length = 0;
    reply.narrationStatusShowing = false;
    await publishInterimMessage(ctx, text);
    return undefined;
  }
  reply.discardedMidTurnNarration = true;
  reply.lastDiscardedMidTurnNarration = clampUserProgressMessage(text);
  if (promotes && !ctx.allowSilentEmptyRun) {
    reply.workingNotes.push(text);
    flushPendingTools(reply);
    reply.messageSegments = noteLastToolStep(reply.messageSegments, text);
  }
  return text;
}

/**
 * Text the bot wrote before asking is what the person needs to answer, and a paused run
 * never reaches the final reply that would bring held notes back. Posts it whole, ahead of
 * the question.
 */
export async function publishNarrationBeforeAsk(ctx: RunContext) {
  const { run } = ctx;
  const { reply } = ctx.state;
  if (!runPromotesMidTurnNarration(run.trigger)) return;
  const extracted = extractNarrationText(reply.messageSegments, reply.currentTextSegment);
  const pending = redactSecretsAfter(reply.narrationSoFar, extracted.text, ctx.secrets).trim();
  reply.narrationSoFar += extracted.text;
  // Messages mode shows only the latest text, as at the end of a turn.
  const held =
    ctx.replyMode === "chat" ? reply.workingNotes : pending ? [] : reply.workingNotes.slice(-1);
  // Held notes were redacted against the secrets known when they were held; check them again.
  const text = redactSecrets([...held, pending].filter(Boolean).join("\n\n"), ctx.secrets);
  if (!text) return;
  reply.messageSegments = extracted.remaining;
  reply.currentTextSegment = "";
  reply.workingNotes.length = 0;
  reply.narrationStatusShowing = false;
  reply.assembled = "";
  reply.hasStreamedText = false;
  reply.pendingProgress = "";
  reply.redactor.skip();
  await publishInterimMessage(ctx, text);
}

/**
 * Replaces the text streamed so far with the note as the working line. Runs that hold their
 * narration back (routines, peers, background work) keep their live view.
 */
export async function showNarrationStatus(ctx: RunContext, note: string | undefined) {
  const { deps, run, runId, bot, thread } = ctx;
  if (
    !note ||
    ctx.scripted ||
    !runPromotesMidTurnNarration(run.trigger) ||
    isBackgroundRunTrigger(run.trigger)
  )
    return;
  ctx.state.reply.narrationStatusShowing = true;
  await deps.events.append({
    spaceId: run.spaceId,
    threadId: thread.id,
    botId: bot.id,
    type: "thread.progress",
    runId,
    payload: { reset: true, text: narrationStatusLine(note), activity: true },
  });
}
