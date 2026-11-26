import type { MessageBlock } from "@rakazo/contracts";
import { JOB_CARD_REPLY_MAX_CHARS, TOOL_CARD_KEY, ToolCardSchema } from "@rakazo/contracts";
import { httpsUrl } from "../primitives/links.js";

export type ToolCardBlock = Extract<MessageBlock, { kind: "job" }>;

/** A long reply is cut to the card's cap rather than losing the whole card with it. */
function cappedReply(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const { reply } = value as { reply?: unknown };
  if (typeof reply !== "string" || reply.length <= JOB_CARD_REPLY_MAX_CHARS) return value;
  return { ...value, reply: reply.slice(0, JOB_CARD_REPLY_MAX_CHARS) };
}

/**
 * The job card a tool result carried at `structuredContent.card`, or undefined when it carried
 * none this host shows. A card is extra: a malformed one is dropped rather than failing the call
 * it belongs to, and a link that is not https is dropped while the card stays.
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
    cappedReply((structuredContent as Record<string, unknown>)[TOOL_CARD_KEY]),
  );
  if (!parsed.success) return undefined;
  const { url, ...card } = parsed.data;
  const link = url === undefined ? undefined : httpsUrl(url);
  return link ? { ...card, url: link } : card;
}
