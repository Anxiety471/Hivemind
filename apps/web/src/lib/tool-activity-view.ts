import type { MessageBlock } from "@rakazo/contracts";
import { isRetiredImportSetup, isToolActivityBlock } from "@rakazo/core";

/** Number of tool calls behind a steps block: the sum of each row's count. */
export function toolStepCount(steps: readonly { count: number }[]): number {
  return steps.reduce((total, step) => total + step.count, 0);
}

/** What one activity panel lists: the reasoning it did and the tools it ran, in order. */
export type ActivityBlock = Extract<MessageBlock, { kind: "thinking" | "steps" }>;

export function activityBlocks(blocks: readonly MessageBlock[]): ActivityBlock[] {
  return blocks.filter(
    (block): block is ActivityBlock => block.kind === "thinking" || block.kind === "steps",
  );
}

/** Every tool call the panel's steps rows stand for. */
export function activityStepCount(blocks: readonly MessageBlock[]): number {
  return activityBlocks(blocks).reduce(
    (total, block) => (block.kind === "steps" ? total + toolStepCount(block.steps) : total),
    0,
  );
}

/** The run time a finished activity panel reports, from the steps block that kept it. */
export function activityDurationMs(blocks: readonly MessageBlock[]): number | undefined {
  return activityBlocks(blocks)
    .filter((block): block is Extract<ActivityBlock, { kind: "steps" }> => block.kind === "steps")
    .findLast((block) => typeof block.durationMs === "number")?.durationMs;
}

/**
 * The newest thing the bot did, as one sentence: a tool status line, the last line it
 * reasoned, or the last tool it ran. It is what the activity panel's trigger shows.
 */
export function latestActivity(blocks: readonly MessageBlock[]): string | undefined {
  const newest = blocks.findLast(
    (block) =>
      block.kind === "thinking" ||
      block.kind === "steps" ||
      (block.kind === "progress" && block.activity === true),
  );
  if (newest?.kind === "progress") return newest.text.trim() || undefined;
  if (newest?.kind === "thinking")
    return newest.lines.findLast((line) => line.trim().length > 0)?.trim() || undefined;
  if (newest?.kind === "steps") {
    const step = newest.steps.at(-1);
    if (!step?.label) return undefined;
    return step.count > 1 ? `${step.label} ×${step.count}` : step.label;
  }
  return undefined;
}

/** Blocks that survive into a message render. */
export function renderableMessageBlocks(
  blocks: readonly MessageBlock[],
  showToolActivity: boolean,
): MessageBlock[] {
  return blocks.filter((block) => isShown(block, showToolActivity));
}

function isShown(block: MessageBlock, showToolActivity: boolean): boolean {
  if (isRetiredImportSetup(block)) return false;
  // The one activity panel carries reasoning and tool rows together, under one switch.
  if (!isToolActivityBlock(block)) return true;
  return showToolActivity && (block.kind === "thinking" || block.kind === "steps");
}

/**
 * True when a bot message's only visible blocks are activity, such as a live run that has
 * reasoned or called tools but not written anything yet. Such a message renders as a slim
 * line between messages instead of inside a chat bubble.
 */
export function isToolOnlyNarration(
  blocks: readonly MessageBlock[],
  showToolActivity: boolean,
): boolean {
  const visible = renderableMessageBlocks(blocks, showToolActivity);
  return (
    visible.length > 0 &&
    visible.every((block) => block.kind === "steps" || block.kind === "thinking")
  );
}

/** True when a message still has at least one block to show under the preference. */
export function messageHasVisibleBlocks(
  blocks: readonly MessageBlock[],
  showToolActivity: boolean,
): boolean {
  return blocks.some((block) => isShown(block, showToolActivity));
}
