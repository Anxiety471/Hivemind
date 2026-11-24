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

/** The kinds of action a finished run summarizes itself by, in the order its phrase lists them. */
export type ActivitySummaryKind =
  | "pages"
  | "files"
  | "search"
  | "commands"
  | "writes"
  | "edits"
  | "browser"
  | "computer";

/** How many action clauses a summary keeps before it gets too long for a trigger. */
export const ACTIVITY_SUMMARY_MAX_CLAUSES = 3;

const SUMMARY_ACTIONS: readonly { kind: ActivitySummaryKind; match: RegExp }[] = [
  // A page it fetched, a file it opened, then what it ran — the order the phrase reads in.
  { kind: "pages", match: /^(web[ _]fetch|fetch|open[ _]url)$/ },
  {
    kind: "files",
    match:
      /^(read[ _]file|read[ _]history|skill[ _]read|list[ _]files|attach[ _]file|open[ _]path|view)$/,
  },
  { kind: "search", match: /^(web[ _]search|websearch|search[ _]history)$/ },
  {
    kind: "commands",
    match: /^(shell|user[ _]computer[ _]shell|bash|terminal|run[ _]command|execute|code[ _]mode)$/,
  },
  { kind: "writes", match: /^(write[ _]file|create[ _]file|save[ _]page)$/ },
  { kind: "edits", match: /^(edit|apply[ _]patch|str[ _]replace|multiedit)$/ },
  { kind: "browser", match: /^browser[ _]/ },
  { kind: "computer", match: /^(computer[ _]|user[ _]computer[ _])/ },
];

/** Details longer than this are likely truncated on one line, so the row expands to show them whole. */
export const STEP_DETAIL_EXPAND_THRESHOLD = 90;

export type StepActionKind =
  | { kind: "fetch"; host?: string }
  | { kind: "search" }
  | { kind: "read_file"; hasTarget: boolean }
  | { kind: "write_file"; hasTarget: boolean }
  | { kind: "edit_file"; hasTarget: boolean }
  | { kind: "list_files"; hasTarget: boolean }
  | { kind: "shell"; hasTarget: boolean }
  | { kind: "browser_navigate"; host?: string }
  | { kind: "browser_snapshot" }
  | { kind: "browser_act" }
  | { kind: "computer_observe" }
  | { kind: "computer_act" }
  | { kind: "attach_file"; hasTarget: boolean }
  | { kind: "open_path"; hasTarget: boolean }
  | { kind: "launch_app"; hasTarget: boolean }
  | { kind: "save_page" }
  | { kind: "search_history" }
  | { kind: "read_history" }
  | { kind: "raw"; label: string };

export type StepDisplayInfo = {
  action: StepActionKind;
  /** The one-line detail shown beside the action: the call's target, or the first line of its note. */
  target?: string;
  /** The call's redacted target detail, when recorded. */
  detail?: string;
  /** The full note written before the call, when recorded. */
  note?: string;
  /** True when clicking the row reveals more (a note, or a long target that may truncate). */
  expandable: boolean;
};

const FIRST_URL_RE = /https?:\/\/[^\s]+/i;

function extractHost(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = text.match(FIRST_URL_RE);
  if (!match) return undefined;
  try {
    const host = new URL(match[0]).hostname.replace(/^www\./i, "");
    return host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turns a stored tool step into a quiet action verb ("Read bend-lang.com", "Searched the web",
 * "Wrote", "Ran") plus the brighter thing it touched. Unknown tools keep their stored label.
 */
export function stepDisplayInfo(step: {
  label: string;
  detail?: string;
  note?: string;
}): StepDisplayInfo {
  const detail = step.detail?.trim() || undefined;
  const note = step.note?.trim() || undefined;
  const firstNoteLine = note
    ?.split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim();
  const target = detail ?? firstNoteLine;
  const hasTarget = target !== undefined;
  const normalized = step.label.trim().toLowerCase().replace(/\s+/g, " ");

  let action: StepActionKind;
  if (/^(web[ _]fetch|fetch|open[ _]url)$/.test(normalized)) {
    action = { kind: "fetch", host: extractHost(target) };
  } else if (/^(web[ _]search|websearch)$/.test(normalized)) {
    action = { kind: "search" };
  } else if (/^(read[ _]file|view)$/.test(normalized)) {
    action = { kind: "read_file", hasTarget };
  } else if (/^(write[ _]file|create[ _]file)$/.test(normalized)) {
    action = { kind: "write_file", hasTarget };
  } else if (/^(edit|apply[ _]patch|str[ _]replace|multiedit)$/.test(normalized)) {
    action = { kind: "edit_file", hasTarget };
  } else if (/^list[ _]files$/.test(normalized)) {
    action = { kind: "list_files", hasTarget };
  } else if (
    /^(shell|user[ _]computer[ _]shell|bash|terminal|run[ _]command|execute)$/.test(normalized)
  ) {
    action = { kind: "shell", hasTarget };
  } else if (/^browser[ _]navigate$/.test(normalized)) {
    action = { kind: "browser_navigate", host: extractHost(target) };
  } else if (/^browser[ _]snapshot$/.test(normalized)) {
    action = { kind: "browser_snapshot" };
  } else if (/^browser[ _]act$/.test(normalized)) {
    action = { kind: "browser_act" };
  } else if (/^(computer[ _]observe|user[ _]computer[ _]observe)$/.test(normalized)) {
    action = { kind: "computer_observe" };
  } else if (/^(computer[ _]act|user[ _]computer[ _]act)$/.test(normalized)) {
    action = { kind: "computer_act" };
  } else if (/^attach[ _]file$/.test(normalized)) {
    action = { kind: "attach_file", hasTarget };
  } else if (/^open[ _]path$/.test(normalized)) {
    action = { kind: "open_path", hasTarget };
  } else if (/^launch[ _]app$/.test(normalized)) {
    action = { kind: "launch_app", hasTarget };
  } else if (/^save[ _]page$/.test(normalized)) {
    action = { kind: "save_page" };
  } else if (/^search[ _]history$/.test(normalized)) {
    action = { kind: "search_history" };
  } else if (/^read[ _]history$/.test(normalized)) {
    action = { kind: "read_history" };
  } else {
    action = { kind: "raw", label: step.label };
  }

  const expandable =
    Boolean(note) || (detail !== undefined && detail.length > STEP_DETAIL_EXPAND_THRESHOLD);
  return {
    action,
    ...(target ? { target } : {}),
    ...(detail ? { detail } : {}),
    ...(note ? { note } : {}),
    expandable,
  };
}

/**
 * What a finished run's steps add up to, as counted actions: "2 pages, 1 search". The kinds
 * come in a fixed, readable order (not the call order); a trigger turns the counts into words.
 * Undefined when no step is a recognized action, so the trigger keeps the plain latest line.
 */
export function activitySummaryParts(
  blocks: readonly MessageBlock[],
): { kind: ActivitySummaryKind; count: number }[] {
  const counts = new Map<ActivitySummaryKind, number>();
  for (const block of activityBlocks(blocks)) {
    if (block.kind !== "steps") continue;
    for (const step of block.steps) {
      const label = step.label.trim().toLowerCase().replace(/\s+/g, " ");
      const action = SUMMARY_ACTIONS.find((candidate) => candidate.match.test(label));
      if (action) counts.set(action.kind, (counts.get(action.kind) ?? 0) + step.count);
    }
  }
  return SUMMARY_ACTIONS.flatMap(({ kind }) => {
    const count = counts.get(kind);
    return count ? [{ kind, count }] : [];
  }).slice(0, ACTIVITY_SUMMARY_MAX_CLAUSES);
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
