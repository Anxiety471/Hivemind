import type { BotMessageIntent, MessageBlock } from "@rakazo/contracts";
import { truncatePlainText } from "../messages/markdown-plain.js";

export const BOT_MESSAGE_MAX_LENGTH = 8_000;

/** Bots that hit the limit tend to resend the text in chunks; the error steers them to files. */
export const BOT_MESSAGE_TOO_LONG = `message exceeds the ${BOT_MESSAGE_MAX_LENGTH} character limit. Nothing was sent. Save long content to a file and send it with files instead of splitting it across messages.`;

/** Default cap on bot-started deliveries in one chain; keeps a runaway two-bot volley bounded. */
export const DEFAULT_BOT_MESSAGE_MAX_HOPS = 6;

/**
 * Cap on how many bot-started deliveries may chain before the next one is refused. Unset,
 * empty, or invalid means the default. An explicit 0 disables the fuse. A person's own
 * message always starts a fresh chain at hop 0.
 */
export function botMessageMaxHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BOT_MESSAGE_MAX_HOPS?.trim();
  if (!raw) return DEFAULT_BOT_MESSAGE_MAX_HOPS;
  const parsed = Number(raw);
  if (parsed === 0) return 0;
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_BOT_MESSAGE_MAX_HOPS;
  return Math.floor(parsed);
}

/** Cap total description characters across the rendered teammate directory. */
export const BOT_DIRECTORY_DESCRIPTIONS_MAX_LENGTH = 8_000;

export interface BotAddress {
  id: string;
  name: string;
  description?: string;
}

export function clampBotMessage(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= BOT_MESSAGE_MAX_LENGTH
    ? trimmed
    : `${truncatePlainText(trimmed, BOT_MESSAGE_MAX_LENGTH - 1).trimEnd()}…`;
}

/** The hop a delivery gets when the sender was itself woken at `sourceHop`. */
export function nextBotMessageHop(sourceHop: number | undefined): number {
  return Number.isInteger(sourceHop) && (sourceHop as number) > 0 ? (sourceHop as number) + 1 : 1;
}

export function botMessageHopExhausted(hop: number): boolean {
  const limit = botMessageMaxHops();
  return limit > 0 && hop > limit;
}

export type BotMessageContext = Extract<MessageBlock, { kind: "bot_message_received" }>;

export function botMessageContext(blocks: readonly MessageBlock[]): BotMessageContext | undefined {
  return blocks.find((block): block is BotMessageContext => block.kind === "bot_message_received");
}

export function botMessageAllowsSilence(
  intent: BotMessageIntent | undefined,
  repliesToRequest = false,
): boolean {
  return intent === "fyi" && !repliesToRequest;
}

/** Same bot name, ignoring surrounding space and case. */
function sameBotName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Resolve by id first, then an unambiguous exact name, then case-insensitively. */
export function resolveBotAddress<T extends BotAddress>(
  bots: readonly T[],
  input: { botId?: string; name?: string },
): T | undefined {
  const botId = input.botId?.trim();
  const name = input.name?.trim();
  if (botId) {
    const match = bots.find((bot) => bot.id === botId);
    // An id and a name that name different bots resolve to neither: never guess which one was meant.
    return match && (!name || sameBotName(match.name, name)) ? match : undefined;
  }
  if (!name) return undefined;
  const exact = bots.filter((bot) => bot.name === name);
  if (exact.length > 0) return exact.length === 1 ? exact[0] : undefined;
  const lower = name.toLowerCase();
  const matches = bots.filter((bot) => bot.name.toLowerCase() === lower);
  return matches.length === 1 ? matches[0] : undefined;
}

export const BOT_ID_NAME_MISMATCH_ERROR = "bot_id and confirm_name do not match the same bot";

/** Why an address did not resolve: the id and name disagree, or nothing matched. */
export function botAddressError(
  bots: readonly BotAddress[],
  input: { botId?: string; name?: string },
): string {
  const botId = input.botId?.trim();
  const name = input.name?.trim();
  const match = botId ? bots.find((bot) => bot.id === botId) : undefined;
  return match && name && !sameBotName(match.name, name)
    ? BOT_ID_NAME_MISMATCH_ERROR
    : "no bot found with that id or name";
}
