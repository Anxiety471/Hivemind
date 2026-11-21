import type { Bot, Ticket } from "@rakazo/contracts";

export const OWNER_ME_VALUE = "user:me";

export function ownerOptionValue(ticket: Ticket | null, currentUserId?: string): string {
  if (!ticket) return OWNER_ME_VALUE;
  if (ticket.ownerBotId) return `bot:${ticket.ownerBotId}`;
  if (ticket.ownerUserId && currentUserId && ticket.ownerUserId !== currentUserId) {
    return `user:${ticket.ownerUserId}`;
  }
  if (ticket.ownerUserId) return OWNER_ME_VALUE;
  if (ticket.assigneeBotId) return `bot:${ticket.assigneeBotId}`;
  return OWNER_ME_VALUE;
}

export function ownerPayloadFromValue(
  value: string,
  currentUserId?: string,
): { ownerUserId: string | null; ownerBotId: string | null } {
  if (value.startsWith("bot:")) {
    return { ownerBotId: value.slice(4), ownerUserId: null };
  }
  if (value === OWNER_ME_VALUE) {
    return { ownerUserId: currentUserId ?? "me", ownerBotId: null };
  }
  if (value.startsWith("user:")) {
    return { ownerUserId: value.slice(5), ownerBotId: null };
  }
  return { ownerUserId: currentUserId ?? null, ownerBotId: null };
}

export function ticketWorkerIds(ticket: Ticket): string[] {
  if (ticket.workerBotIds.length > 0) return ticket.workerBotIds;
  return ticket.assigneeBotId ? [ticket.assigneeBotId] : [];
}

export function ticketInvolvesBot(ticket: Ticket, botId: string): boolean {
  return ticket.ownerBotId === botId || ticketWorkerIds(ticket).includes(botId);
}

export function ticketWorkerNames(ticket: Ticket, bots: readonly Bot[]): string[] {
  const byId = new Map(bots.map((bot) => [bot.id, bot.name]));
  return ticketWorkerIds(ticket)
    .map((id) => byId.get(id))
    .filter((name): name is string => Boolean(name));
}

export function ticketOwnerLabel(
  ticket: Ticket,
  bots: readonly Bot[],
  currentUserId: string | undefined,
  labels: { me: string; member: string },
): string | null {
  if (ticket.ownerBotId) {
    return bots.find((bot) => bot.id === ticket.ownerBotId)?.name ?? null;
  }
  if (ticket.ownerUserId) {
    return !currentUserId || ticket.ownerUserId === currentUserId ? labels.me : labels.member;
  }
  return null;
}

export function sameIdList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

const USER_MENTION_PRONOUN_RE =
  /(?:^|[^\w])@(?:user|me|owner|you)(?=$|[^\w])|\b(?:blocked|waiting)\s+on\s+@?(?:user|me|owner|you)\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function textMentionsCurrentUser(
  text: string | null | undefined,
  currentUserName?: string | null,
): boolean {
  if (!text?.trim()) return false;
  if (USER_MENTION_PRONOUN_RE.test(text)) return true;
  const trimmed = currentUserName?.trim() ?? "";
  if (!trimmed) return false;
  const first = trimmed.split(/\s+/)[0]?.trim() ?? "";
  for (const candidate of [trimmed, first]) {
    if (candidate.length < 2) continue;
    const escaped = escapeRegExp(candidate);
    const re = new RegExp(
      `(?:^|[^\\w])@${escaped}(?=$|[^\\w])|\\b(?:blocked|waiting)\\s+on\\s+@?${escaped}(?=$|[^\\w])`,
      "i",
    );
    if (re.test(text)) return true;
  }
  return false;
}

export function ticketMentionsMe(ticket: Ticket, currentUserName?: string | null): boolean {
  if (ticket.mentionsMe) return true;
  return (
    textMentionsCurrentUser(ticket.title, currentUserName) ||
    textMentionsCurrentUser(ticket.description, currentUserName)
  );
}
