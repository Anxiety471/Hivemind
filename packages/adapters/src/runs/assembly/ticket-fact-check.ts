import type { MessageBlock } from "@rakazo/contracts";
import { parseTicketRef } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { coerceTicketStatus, readTicketDecision } from "@rakazo/db";
import { extractTicketRefs, TICKET_REF_HINT } from "../../tasks/ticket-context.js";

/**
 * Deterministic check of a reply's ticket claims against the live board. No model call: a claim
 * only counts when one sentence or bullet names the ticket and states its status plainly.
 */

export type LiveTicketFact = {
  ref: string;
  title: string;
  status: string;
  decision?: { question: string; answer?: string } | null;
};

export type TicketFactMismatch =
  | { kind: "missing"; ref: string }
  | { kind: "closed_claimed_open"; ref: string; live: LiveTicketFact }
  | { kind: "open_claimed_closed"; ref: string; live: LiveTicketFact };

const MAX_CHECKED_REFS = 20;
const MAX_TITLE_CHARS = 120;

const FENCE = /^\s{0,3}(```|~~~)/;
const OPEN_CLAIM =
  /\b(is still open|still open|is open|remains open|is blocked|is pending|not chosen yet|not answered|has no answer|no answer yet|waiting on user|needs your decision|needs a decision|awaits? (?:a |your )?decision)\b/i;
const CLOSED_CUE = /\b(done|closed|completed|no longer open|not open|was open)\b/i;
const DONE_CLAIM =
  /\b(is (?:now )?(?:done|closed|completed)|are (?:now )?(?:done|closed|completed)|marked (?:as )?(?:done|closed))\b/i;
/** Negated, conditional, or future phrasings that do not assert the state as fact. */
const CONDITIONAL_CUE = /\b(not|never|no|once|when|if|until|will be|should be)\b|n't\b/i;
const NOT_FOUND_CUE =
  /\b(does not exist|do not exist|not exist|doesn't exist|don't exist|not found|wasn't found|was not found|no such|invalid|not on (?:the|this) board)\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Drops fenced code blocks: a ticket named in a code sample is not a claim. */
function stripFencedCode(text: string): string {
  let fence: string | undefined;
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const match = FENCE.exec(line);
    if (fence) {
      if (match?.[1] === fence) fence = undefined;
      continue;
    }
    if (match) {
      fence = match[1];
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/** Sentences and bullets, so each claim is judged against only the text that names its ticket. */
function clausesOf(text: string): string[] {
  return text
    .split("\n")
    .flatMap((line) => line.split(/(?<=[.?!])\s+/))
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function mentionPattern(ref: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(ref)}(?![0-9])`, "i");
}

function isClosedStatus(status: string): boolean {
  return status === "done" || status === "closed";
}

/** Refs the check evaluates, from prose only, capped so one long reply stays cheap. */
function checkedRefs(text: string, prefix: string): string[] {
  return extractTicketRefs(stripFencedCode(text), prefix).slice(0, MAX_CHECKED_REFS);
}

export function findTicketFactMismatches(
  text: string,
  prefix: string,
  liveByRef: ReadonlyMap<string, LiveTicketFact>,
): TicketFactMismatch[] {
  const prose = stripFencedCode(text);
  const clauses = clausesOf(prose);
  const mismatches: TicketFactMismatch[] = [];
  for (const ref of checkedRefs(prose, prefix)) {
    const mentioning = clauses.filter((clause) => mentionPattern(ref).test(clause));
    const live = liveByRef.get(ref);
    if (!live) {
      if (!mentioning.some((clause) => NOT_FOUND_CUE.test(clause))) {
        mismatches.push({ kind: "missing", ref });
      }
      continue;
    }
    if (isClosedStatus(live.status)) {
      if (mentioning.some((clause) => OPEN_CLAIM.test(clause) && !CLOSED_CUE.test(clause))) {
        mismatches.push({ kind: "closed_claimed_open", ref, live });
      }
      continue;
    }
    if (mentioning.some((clause) => DONE_CLAIM.test(clause) && !CONDITIONAL_CUE.test(clause))) {
      mismatches.push({ kind: "open_claimed_closed", ref, live });
    }
  }
  return mismatches;
}

function formatMismatch(mismatch: TicketFactMismatch): string {
  if (mismatch.kind === "missing") return `**${mismatch.ref}** does not exist on this board.`;
  const { live } = mismatch;
  const title =
    live.title.length > MAX_TITLE_CHARS
      ? `${live.title.slice(0, MAX_TITLE_CHARS - 1)}…`
      : live.title;
  if (mismatch.kind === "closed_claimed_open") {
    const answered = Boolean(live.decision?.answer?.trim());
    return `**${mismatch.ref}** is **${live.status}** on the board (${title})${answered ? " — decision answered" : ""}.`;
  }
  const pending = live.decision && !live.decision.answer?.trim() ? live.decision : null;
  return `**${mismatch.ref}** is **${live.status}** on the board (${title})${
    pending ? ` — decision pending: ${pending.question}` : ""
  }.`;
}

export function formatTicketFactCheckNote(mismatches: readonly TicketFactMismatch[]): string {
  return `> **Board check:** ${mismatches.map(formatMismatch).join("\n> ")}`;
}

export async function appendTicketFactCheckIfNeeded(
  deps: { prisma: PrismaClient },
  spaceId: string,
  blocks: MessageBlock[],
): Promise<{ blocks: MessageBlock[]; mismatches: TicketFactMismatch[] }> {
  const allText = blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join("\n");
  if (!TICKET_REF_HINT.test(allText)) return { blocks, mismatches: [] };

  const board = await deps.prisma.board.findUnique({
    where: { spaceId },
    select: { id: true, ticketPrefix: true },
  });
  if (!board) return { blocks, mismatches: [] };
  const prefix = board.ticketPrefix.trim().toUpperCase();
  const refs = checkedRefs(allText, prefix);
  const numbers = refs.flatMap((ref) => {
    const parsed = parseTicketRef(ref, prefix);
    return parsed ? [parsed.number] : [];
  });
  if (numbers.length === 0) return { blocks, mismatches: [] };

  const rows = await deps.prisma.ticket.findMany({
    where: { spaceId, boardId: board.id, number: { in: numbers } },
  });
  const liveByRef = new Map<string, LiveTicketFact>(
    rows.map((row) => {
      const ref = `${prefix}-${row.number}`;
      return [
        ref,
        {
          ref,
          title: row.title,
          status: coerceTicketStatus(row.status),
          decision: readTicketDecision(row),
        },
      ];
    }),
  );

  const mismatches = findTicketFactMismatches(allText, prefix, liveByRef);
  if (mismatches.length === 0) return { blocks, mismatches };
  return {
    blocks: [...blocks, { kind: "text", text: `\n\n${formatTicketFactCheckNote(mismatches)}` }],
    mismatches,
  };
}
