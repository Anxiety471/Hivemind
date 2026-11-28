import type { MessageBlock } from "@rakazo/contracts";
import { EMPTY_RESPONSE_FALLBACK_TEXT } from "@rakazo/core";
import { messageBlocksText } from "./run-replies.prompt.js";
import { isPlaceholderText } from "./silent-reply.js";

export type EmptyResponseReason =
  | "model_empty"
  | "thinking_only"
  | "placeholder_only"
  | "no_response_fallback";

export interface CapturedEmptyResponse {
  reason: EmptyResponseReason;
  hadThinking: boolean;
  thinkingChars: number;
  /** Reminder prompts the runtime sent after the empty answer before this one was kept. */
  reminders: number;
}

/**
 * Decides whether a finished turn produced nothing a person should see: no text, only reasoning,
 * or only a placeholder (or the no-response fallback). Such a turn is captured and kept out of
 * the chat. Real activity (tool steps, asks, files, child bots) and contextual peer notices are
 * never empty responses.
 */
export function detectEmptyResponse(input: {
  assembled: string;
  blocks: readonly MessageBlock[];
  /** Original blocks before groupSilentEnd cleared them, so thinking is still accounted for. */
  sourceBlocks?: readonly MessageBlock[];
  runtimeEmptyResponse: boolean;
  emptyResponseText?: string;
  /** Reminder prompts the runtime sent after an empty answer. */
  emptyResponseReminders?: number;
  allowSilentEmpty: boolean;
  groupSilentEnd: boolean;
  handedOff: boolean;
  backgroundRun: boolean;
  publishedMidTurnUserMessage: boolean;
  publishedTerminalSubagent: boolean;
  explicitNoResponse: boolean;
}): CapturedEmptyResponse | null {
  if (
    input.handedOff ||
    input.backgroundRun ||
    input.publishedMidTurnUserMessage ||
    input.publishedTerminalSubagent
  ) {
    return null;
  }
  // A run that may stay silent never shows its contextual notice, so an empty one is still empty.
  // Where the notice is shown (a request, result, status or a reply), it is a real message.
  if (!input.allowSilentEmpty && input.emptyResponseText?.trim()) return null;
  if (input.blocks.some((block) => block.kind !== "text" && block.kind !== "thinking")) {
    return null;
  }
  const thinkingSource = input.blocks.some((block) => block.kind === "thinking")
    ? input.blocks
    : (input.sourceBlocks ?? input.blocks);
  const thinkingBlocks = thinkingSource.filter(
    (block): block is Extract<MessageBlock, { kind: "thinking" }> => block.kind === "thinking",
  );
  const hadThinking = thinkingBlocks.length > 0;
  const thinkingChars = thinkingBlocks.reduce(
    (total, block) => total + block.lines.reduce((sum, line) => sum + line.length, 0),
    0,
  );
  // Group silence clears the blocks, so the text it hid is read from the source too.
  const rawText =
    input.assembled ||
    messageBlocksText(input.blocks) ||
    messageBlocksText(input.sourceBlocks ?? []);
  const trimmedText = rawText.trim();
  const reminders = input.emptyResponseReminders ?? 0;
  const empty = (reason: EmptyResponseReason): CapturedEmptyResponse => ({
    reason,
    hadThinking,
    thinkingChars,
    reminders,
  });
  if (input.allowSilentEmpty || input.groupSilentEnd) {
    // An intentional NO_RESPONSE is a normal silence, not an empty-response incident.
    if (input.explicitNoResponse) return null;
    if (trimmedText === EMPTY_RESPONSE_FALLBACK_TEXT) return empty("no_response_fallback");
    if (input.runtimeEmptyResponse || trimmedText === "") {
      return empty(hadThinking ? "thinking_only" : "model_empty");
    }
    if (isPlaceholderText(rawText)) return empty("placeholder_only");
    return null;
  }
  if (trimmedText === EMPTY_RESPONSE_FALLBACK_TEXT) return empty("no_response_fallback");
  if (trimmedText === "" || input.runtimeEmptyResponse) {
    return empty(hadThinking ? "thinking_only" : "model_empty");
  }
  if (isPlaceholderText(rawText)) return empty("placeholder_only");
  return null;
}
