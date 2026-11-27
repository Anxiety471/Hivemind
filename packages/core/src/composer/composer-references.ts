import { ticketLinkLabel } from "@rakazo/contracts";
import { CJK_CHAR } from "./group-mentions.js";

/** The active #query at a collapsed caret. `start` is the index of the `#`. */
export type ComposerReferenceQuery = {
  /** Start offset of `#` in the draft text. */
  start: number;
  /** End offset (the caret position). */
  end: number;
  /** Text typed after `#` (without `#`). */
  query: string;
};

export type ComposerReferenceTicketInput = {
  id?: string;
  ref: string;
  title?: string;
  status?: string;
  priority?: string;
  repository?: string | null;
  pullRequests?: readonly { url: string; state?: string }[];
  decision?: { question: string; answer?: string } | null;
};

export type ComposerReferenceOption =
  | {
      kind: "ticket";
      /** Unique React key, e.g. "ticket:TASK-418". */
      key: string;
      /** Text inserted into composer (e.g. "TASK-418"). */
      insertText: string;
      ref: string;
      title: string;
      status: string;
      priority?: string;
      pendingDecision: boolean;
      closed: boolean;
    }
  | {
      kind: "pull_request";
      /** Unique React key, e.g. "pr:https://.../pull/249". */
      key: string;
      /** Text inserted into composer (e.g. "owner/repo#249"). */
      insertText: string;
      label: string;
      number: number;
      state?: string;
      ticketRef?: string;
      ticketTitle?: string;
      url: string;
    };

// A reference being typed starts after a space or, as in "请#418", Chinese, Japanese or Korean text.
// Inside the query a "#" may separate a repository from its number ("owner/repo#249"), but a
// leading "#" (a Markdown heading such as "##") never starts one.
const PARTIAL_REFERENCE = new RegExp(
  `(?:^|\\s|${CJK_CHAR})#((?:[A-Za-z0-9_./-]|#(?=[A-Za-z0-9_./-])){0,60})$`,
  "u",
);

/** The active #query before a collapsed caret, or null when no reference is being typed. */
export function findComposerReferenceQuery(
  text: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): ComposerReferenceQuery | null {
  if (selectionStart !== selectionEnd || selectionStart < 0 || selectionStart > text.length)
    return null;
  const match = PARTIAL_REFERENCE.exec(text.slice(0, selectionStart));
  if (!match) return null;
  const query = match[1] ?? "";
  return { start: selectionStart - query.length - 1, end: selectionStart, query };
}

const CLOSED_TICKET_STATUSES = new Set(["done", "closed"]);

function isClosedPullRequest(state: string | undefined): boolean {
  const normalized = state?.toLowerCase();
  return normalized === "merged" || normalized === "closed";
}

/** Trailing number of a ticket ref ("TASK-418" -> 418), or 0 when there is none. */
function refNumber(ref: string): number {
  return Number(/(\d+)$/.exec(ref)?.[1] ?? 0);
}

/** Tickets first: open with a pending decision, other open, then PRs open, then closed/merged PRs, then closed tickets. Newest number first within each group. */
function defaultRank(option: ComposerReferenceOption): number {
  if (option.kind === "ticket") {
    if (option.closed) return 4;
    return option.pendingDecision ? 0 : 1;
  }
  return isClosedPullRequest(option.state) ? 3 : 2;
}

function optionNumber(option: ComposerReferenceOption): number {
  return option.kind === "ticket" ? refNumber(option.ref) : option.number;
}

function isOpen(option: ComposerReferenceOption): boolean {
  return option.kind === "ticket" ? !option.closed : !isClosedPullRequest(option.state);
}

/**
 * Ticket options plus the distinct linked pull requests among them, in default picker order.
 * A PR named by several tickets appears once, preferring an open state.
 */
export function composerReferenceOptionsFrom(
  tickets: readonly ComposerReferenceTicketInput[],
): ComposerReferenceOption[] {
  const ticketOptions: ComposerReferenceOption[] = tickets.map((ticket) => {
    const status = ticket.status ?? "";
    const closed = CLOSED_TICKET_STATUSES.has(status);
    return {
      kind: "ticket",
      key: `ticket:${ticket.ref}`,
      insertText: ticket.ref,
      ref: ticket.ref,
      title: ticket.title ?? "",
      status,
      priority: ticket.priority,
      pendingDecision: !closed && Boolean(ticket.decision && !ticket.decision.answer?.trim()),
      closed,
    };
  });

  const pullRequests = new Map<string, ComposerReferenceOption & { kind: "pull_request" }>();
  for (const ticket of tickets) {
    for (const pr of ticket.pullRequests ?? []) {
      const key = pr.url.toLowerCase();
      const existing = pullRequests.get(key);
      if (existing && (!isClosedPullRequest(existing.state) || isClosedPullRequest(pr.state)))
        continue;
      // ticketLinkLabel matches lowercase URLs only; mixed-case owners still need a label.
      const label = ticketLinkLabel(pr.url.trim().toLowerCase());
      const number = Number(/#(\d+)$/.exec(label)?.[1]);
      if (!Number.isInteger(number)) continue;
      pullRequests.set(key, {
        kind: "pull_request",
        key: `pr:${pr.url}`,
        insertText: label,
        label,
        number,
        state: pr.state,
        ticketRef: ticket.ref,
        ticketTitle: ticket.title,
        url: pr.url,
      });
    }
  }

  return [...ticketOptions, ...pullRequests.values()].sort(
    (a, b) => defaultRank(a) - defaultRank(b) || optionNumber(b) - optionNumber(a),
  );
}

/** Words of a title, lowercased, for prefix matching. */
function titleWords(value: string | undefined): string[] {
  return (value ?? "")
    .toLowerCase()
    .split(/[\s\p{P}]+/u)
    .filter(Boolean);
}

/** How well one query term matches an option; 0 when it does not match at all. */
function termScore(option: ComposerReferenceOption, term: string): number {
  const number = String(optionNumber(option));
  const ref = option.kind === "ticket" ? option.ref.toLowerCase() : option.label.toLowerCase();
  const exact =
    option.kind === "ticket"
      ? ref === term || number === term
      : ref === term || ref.endsWith(`#${term}`) || number === term;
  if (exact) return 100;
  const prefix =
    ref.startsWith(term) ||
    number.startsWith(term) ||
    (option.kind === "pull_request" && ref.includes(`#${term}`));
  if (prefix) return 80;
  const titleWordHit = titleWords(
    option.kind === "ticket" ? option.title : option.ticketTitle,
  ).some((word) => word.startsWith(term));
  if (titleWordHit) return 40;
  const haystack = [
    ref,
    option.kind === "ticket" ? option.title : option.ticketTitle,
    option.kind === "ticket" ? option.status : option.state,
    option.kind === "pull_request" ? option.ticketRef : undefined,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return haystack.includes(term) ? 20 : 0;
}

/**
 * Picker options for a typed `#` query. An empty query shows open items first (all items when
 * none are open). Otherwise every query word must match, exact numbers and refs rank above
 * prefixes and title words, and open items rank above closed ones.
 */
export function filterComposerReferences(
  options: readonly ComposerReferenceOption[],
  query: string,
  limit = 12,
): ComposerReferenceOption[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    const open = options.filter(isOpen);
    return (open.length > 0 ? open : [...options]).slice(0, limit);
  }
  const scored = options.flatMap((option, index) => {
    let score = 0;
    for (const term of terms) {
      const matched = termScore(option, term);
      if (matched === 0) return [];
      score += matched;
    }
    return [{ option, index, score: score + (isOpen(option) ? 10 : 0) }];
  });
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ option }) => option);
}

/** Insert the chosen reference in place of the `#query`, followed by one space. */
export function applyComposerReference(
  text: string,
  query: ComposerReferenceQuery,
  option: Pick<ComposerReferenceOption, "insertText">,
): { text: string; cursor: number } {
  const suffix = text.slice(query.end);
  const separator = /^\s/.test(suffix) ? "" : " ";
  const inserted = `${option.insertText}${separator}`;
  return {
    text: `${text.slice(0, query.start)}${inserted}${suffix}`,
    cursor: query.start + option.insertText.length + 1,
  };
}
