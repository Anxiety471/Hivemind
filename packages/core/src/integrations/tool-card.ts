import type { MessageBlock } from "@rakazo/contracts";
import {
  JOB_CARD_FILE_DIFF_MAX_CHARS,
  JOB_CARD_MAX_FILES,
  JOB_CARD_MAX_STEPS,
  JOB_CARD_REPLY_MAX_CHARS,
  TOOL_CARD_KEY,
  ToolCardSchema,
} from "@rakazo/contracts";
import { httpsUrl } from "../primitives/links.js";

export type ToolCardBlock = Extract<MessageBlock, { kind: "job" }>;

/* The contract's own cap for each short field. They are spread over the schema rather than
   exported, so the sanitizer keeps its own copy and stays in step with the max it mirrors. */
const SUMMARY_MAX_CHARS = 400;
const ACTIVITY_MAX_CHARS = 240;
const ERROR_MAX_CHARS = 600;
const STEP_DETAIL_MAX_CHARS = 400;

/**
 * The longest head of `value` that fits `max` UTF-16 units, never splitting a surrogate pair
 * (the same unit zod counts, so the clipped value always passes the next parse).
 */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = value.slice(0, max);
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

/**
 * Trims and clips one required-after-trim field, dropping it when trimming leaves nothing.
 * A value that is not a string is left for the schema to judge, so a wrong type still drops
 * the whole card instead of quietly losing a field.
 */
function fitField(card: Record<string, unknown>, key: string, max: number): void {
  const value = card[key];
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed) {
    delete card[key];
    return;
  }
  card[key] = clip(trimmed, max);
}

/** Trims and clips one field that may legitimately be empty, such as a reply or a step detail. */
function fitEmptyableField(card: Record<string, unknown>, key: string, max: number): void {
  const value = card[key];
  if (typeof value !== "string") return;
  card[key] = clip(value.trim(), max);
}

/**
 * A card whose details run past their caps is cut to fit rather than lost: the reply, a step's
 * detail and a file's diff are clipped, and only the most recent steps survive.
 */
function fitCard(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const card = { ...(value as Record<string, unknown>) };

  fitEmptyableField(card, "reply", JOB_CARD_REPLY_MAX_CHARS);
  fitField(card, "summary", SUMMARY_MAX_CHARS);
  fitField(card, "currentActivity", ACTIVITY_MAX_CHARS);
  fitField(card, "error", ERROR_MAX_CHARS);

  if (Array.isArray(card.files)) {
    card.files = card.files.slice(0, JOB_CARD_MAX_FILES).map((file) => {
      if (!file || typeof file !== "object") return file;
      const entry = { ...(file as Record<string, unknown>) };
      fitEmptyableField(entry, "diff", JOB_CARD_FILE_DIFF_MAX_CHARS);
      return entry;
    });
  }

  if (Array.isArray(card.steps)) {
    card.steps = card.steps.slice(-JOB_CARD_MAX_STEPS).map((step) => {
      if (!step || typeof step !== "object") return step;
      const entry = { ...(step as Record<string, unknown>) };
      fitEmptyableField(entry, "detail", STEP_DETAIL_MAX_CHARS);
      return entry;
    });
  }

  return card;
}

/** A link the card may keep: https only, never one carrying credentials. */
function keptLink(value: string | undefined): string | undefined {
  return value === undefined ? undefined : httpsUrl(value);
}

/**
 * The job card a tool result carried at `structuredContent.card`, or undefined when it carried
 * none this host shows. A card is extra: a malformed one is dropped rather than failing the call
 * it belongs to, a detail past its cap is cut to fit, and a link that is not https is dropped
 * while the card stays.
 */
export function toolCardFromResult(result: unknown): ToolCardBlock | undefined {
  if (!result || typeof result !== "object") return undefined;
  const { isError, structuredContent } = result as {
    isError?: unknown;
    structuredContent?: unknown;
  };
  if (isError === true) return undefined;
  if (!structuredContent || typeof structuredContent !== "object") return undefined;
  const parsed = ToolCardSchema.safeParse(
    fitCard((structuredContent as Record<string, unknown>)[TOOL_CARD_KEY]),
  );
  if (!parsed.success) return undefined;
  const { url, prUrl, ...card } = parsed.data;
  const link = keptLink(url);
  const pullRequest = keptLink(prUrl);
  return {
    ...card,
    ...(link ? { url: link } : {}),
    ...(pullRequest ? { prUrl: pullRequest } : {}),
  };
}
