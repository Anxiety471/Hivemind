import type { TicketIssueState, TicketPullRequestState } from "@rakazo/contracts";
import {
  hasPendingTicketDecision,
  isTicketCompletedStatus,
  normalizeIssueUrl,
  normalizePullRequestUrl,
  pullRequestMergeFinishesTicket,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  coerceTicketStatus,
  JsonColumnMismatchError,
  Prisma,
  readStoredTicketIssues,
  readStoredTicketPullRequests,
  readTicketDecision,
  reportJsonColumnOnce,
} from "@rakazo/db";
import type { TicketChangeNotifier } from "./ticket-changes.js";

type Deps = { prisma: PrismaClient; onTicketChange?: TicketChangeNotifier };
type TicketRow = Awaited<ReturnType<PrismaClient["ticket"]["update"]>>;

/**
 * Records a pull request's new state on every ticket in the Space that links it. A merge that
 * settles the last open link moves the ticket to done, the way a person closing it would.
 * Returns how many tickets changed.
 */
export async function recordTicketPullRequestState(
  deps: Deps,
  input: { spaceId: string; url: string; state: TicketPullRequestState },
): Promise<number> {
  const url = normalizePullRequestUrl(input.url);
  if (!url) return 0;
  return recordLinkState(deps, input.spaceId, url, "pullRequests", async (tx, row) => {
    const current = readStoredTicketPullRequests(row);
    if (!current.some((item) => item.url === url && item.state !== input.state)) return null;
    const next = current.map((item) => (item.url === url ? { url, state: input.state } : item));
    const finishes =
      !isTicketCompletedStatus(coerceTicketStatus(row.status)) &&
      pullRequestMergeFinishesTicket(current, next);
    const pendingDecision = hasPendingTicketDecision({ decision: readTicketDecision(row) });
    return tx.ticket.update({
      where: { id: row.id },
      data: {
        pullRequests: next,
        ...(finishes
          ? {
              status: "done",
              completedAt: new Date(),
              archivedAt: null,
              // The merge answers what the ticket was waiting on.
              ...(pendingDecision ? { decision: Prisma.DbNull } : {}),
            }
          : {}),
      },
    });
  });
}

/**
 * Records an issue's new state on every ticket in the Space that links it. An issue's state never
 * moves the ticket. Returns how many tickets changed.
 */
export async function recordTicketIssueState(
  deps: Deps,
  input: { spaceId: string; url: string; state: TicketIssueState },
): Promise<number> {
  const url = normalizeIssueUrl(input.url);
  if (!url) return 0;
  return recordLinkState(deps, input.spaceId, url, "issues", async (tx, row) => {
    const current = readStoredTicketIssues(row);
    if (!current.some((item) => item.url === url && item.state !== input.state)) return null;
    return tx.ticket.update({
      where: { id: row.id },
      data: {
        issues: current.map((item) => (item.url === url ? { url, state: input.state } : item)),
      },
    });
  });
}

/** Locks the Space's tickets whose `column` list links `url` and applies `change` to each. */
async function recordLinkState(
  deps: Deps,
  spaceId: string,
  url: string,
  column: "pullRequests" | "issues",
  change: (tx: Prisma.TransactionClient, row: TicketRow) => Promise<TicketRow | null>,
): Promise<number> {
  const changed = await deps.prisma.$transaction(async (tx) => {
    const linked = JSON.stringify([{ url }]);
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM tickets
      WHERE "spaceId" = ${spaceId} AND ${Prisma.raw(`"${column}"`)} @> ${linked}::jsonb
      ORDER BY id
      FOR UPDATE`;
    const rows = await tx.ticket.findMany({
      where: { id: { in: locked.map((row) => row.id) }, spaceId },
    });
    const updated: TicketRow[] = [];
    for (const row of rows) {
      try {
        const next = await change(tx, row);
        if (next) updated.push(next);
      } catch (error) {
        if (!(error instanceof JsonColumnMismatchError)) throw error;
        reportJsonColumnOnce("Skipped a ticket whose linked items are unreadable", error.row);
      }
    }
    return updated;
  });
  for (const row of changed) {
    await deps.onTicketChange?.({
      spaceId: row.spaceId,
      boardId: row.boardId,
      ticketId: row.id,
      assigneeBotId: row.assigneeBotId,
      wakeAssignee: false,
      wakeBotIds: [],
    });
  }
  return changed.length;
}
