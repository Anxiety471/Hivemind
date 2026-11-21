import type { Bot, Ticket, TicketComment, TicketDecision } from "@rakazo/contracts";
import { hasPendingTicketDecision, TICKET_DECISION_OPTION_MAX_LENGTH } from "@rakazo/contracts";

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
  /(?:^|[^\w])@(?:user|me|owner|you)(?=$|[^\w])|\b(?:blocked|waiting)\s+on\s+@?(?:user|me|owner|you)\b|\b(?:needs|awaiting)\s+(?:@?(?:user|me|owner|you)|authorization|approval|direction|decision)\b|\b(?:choose|decide)\s+(?:keep|whether)\b/i;

function truncateDecisionOption(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= TICKET_DECISION_OPTION_MAX_LENGTH) return cleaned;
  return `${cleaned.slice(0, TICKET_DECISION_OPTION_MAX_LENGTH - 1)}…`;
}

function extractInlineOptions(text: string): string[] | null {
  const letteredMatches = [
    ...text.matchAll(
      /(?:^|[\s:;,.(])\(?([a-c1-3])\)\s+([^;\n]+?)(?=(?:\s*;|\n|\s+\(?[a-c1-3]\)|$))/gi,
    ),
  ];
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const match of letteredMatches) {
    const marker = (match[1] ?? "").toLowerCase();
    const expectedIndex = labels.length;
    const expectedLetters = ["a", "b", "c"];
    const expectedNumbers = ["1", "2", "3"];
    if (marker !== expectedLetters[expectedIndex] && marker !== expectedNumbers[expectedIndex]) {
      continue;
    }
    const label = truncateDecisionOption((match[2] ?? "").replace(/[.;,\s]+$/, ""));
    if (!label || label.length < 4 || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    labels.push(label);
    if (labels.length === 3) break;
  }
  if (labels.length < 2) return null;
  if (labels.length === 2) labels.push("Hold and review before changing");
  return labels;
}

/**
 * Provides a 3-choice (+ 1 recommended) decision for open blocked/review tickets awaiting user input
 * when a structured decision has not yet been written to the database by the worker bot.
 */
export function deriveTicketDecision(
  ticket: Ticket,
  comments?: readonly TicketComment[],
): TicketDecision | undefined {
  if (hasPendingTicketDecision(ticket)) return ticket.decision;
  if (ticket.decision?.answer) return undefined;
  if (ticket.status !== "blocked" && ticket.status !== "review") return undefined;
  if ((ticket.waitingOnBotIds?.length ?? 0) > 0 && !ticketMentionsMe(ticket)) return undefined;

  const latestComment = comments && comments.length > 0 ? comments[comments.length - 1]?.body : "";
  const combinedText = [ticket.title, ticket.description ?? "", latestComment ?? ""].join("\n");

  const extracted = extractInlineOptions(combinedText);
  if (extracted) {
    return {
      question: ticket.title,
      options: extracted.map((label, index) => ({
        id: `fallback-${index + 1}`,
        label,
        ...(index === 0 ? { recommended: true } : {}),
      })),
    };
  }

  if (/\bkeep\b.*\bor\s+delete\b|\boverage\b/i.test(combinedText)) {
    return {
      question: "How should we handle the preserved archive and storage overage?",
      options: [
        { id: "fallback-1", label: "Keep preserved archive (accept overage)", recommended: true },
        { id: "fallback-2", label: "Delete preserved archive copy now" },
        { id: "fallback-3", label: "Verify latest archive restore first, then delete" },
      ],
    };
  }

  if (
    ticket.status === "blocked" &&
    /\b(?:fix|patch|apply|reword|exclude|guard|retention|KEEP=)\b/i.test(combinedText)
  ) {
    return {
      question: ticket.title,
      options: [
        { id: "fallback-1", label: "Approve and apply the proposed change", recommended: true },
        { id: "fallback-2", label: "Hold — keep blocked without changes for now" },
        { id: "fallback-3", label: "Close task without applying" },
      ],
    };
  }

  if (ticket.status === "review") {
    return {
      question: ticket.title,
      options: [
        { id: "fallback-1", label: "Approve and mark done", recommended: true },
        { id: "fallback-2", label: "Request changes and move back to To do" },
        { id: "fallback-3", label: "Keep in review for now" },
      ],
    };
  }

  return {
    question: ticket.title,
    options: [
      { id: "fallback-1", label: "Approve and proceed", recommended: true },
      { id: "fallback-2", label: "Hold — keep blocked for now" },
      { id: "fallback-3", label: "Close as won't do" },
    ],
  };
}

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
  if (ticket.status !== "blocked" && ticket.status !== "review") return false;
  if (hasPendingTicketDecision(ticket)) return true;
  if (ticket.mentionsMe !== undefined) return ticket.mentionsMe;
  return (
    textMentionsCurrentUser(ticket.title, currentUserName) ||
    textMentionsCurrentUser(ticket.description, currentUserName)
  );
}

/**
 * Concise list of people/bots on a ticket without repeating the same name when owner and worker
 * match.
 */
export function ticketPeopleSummary(
  ticket: Ticket,
  bots: readonly Bot[],
  currentUserId: string | undefined,
  labels: { me: string; member: string },
): string | null {
  const workers = ticketWorkerNames(ticket, bots);
  const owner = ticketOwnerLabel(ticket, bots, currentUserId, labels);
  if (workers.length > 0) {
    if (owner && !workers.includes(owner)) {
      return `${workers.join(", ")} (${owner})`;
    }
    return workers.join(", ");
  }
  return owner;
}
