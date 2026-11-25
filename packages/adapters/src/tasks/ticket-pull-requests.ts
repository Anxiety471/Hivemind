import type { TicketPullRequest, TicketPullRequestState } from "@rakazo/contracts";
import {
  hasPendingTicketDecision,
  isTicketCompletedStatus,
  normalizePullRequestUrl,
  pullRequestsFinishTicket,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  coerceTicketStatus,
  JsonColumnMismatchError,
  Prisma,
  readStoredTicketPullRequests,
  readTicketDecision,
  reportJsonColumnOnce,
} from "@rakazo/db";
import type { TicketChangeNotifier } from "./ticket-changes.js";

/**
 * Records a pull request's new state on every ticket in the Space that links it. A merge that
 * settles the last open link moves the ticket to done, the way a person closing it would.
 * Returns how many tickets changed.
 */
export async function recordTicketPullRequestState(
  deps: { prisma: PrismaClient; onTicketChange?: TicketChangeNotifier },
  input: { spaceId: string; url: string; state: TicketPullRequestState },
): Promise<number> {
  const url = normalizePullRequestUrl(input.url);
  if (!url) return 0;
  const changed = await deps.prisma.$transaction(async (tx) => {
    const linked = JSON.stringify([{ url }]);
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM tickets
      WHERE "spaceId" = ${input.spaceId} AND "pullRequests" @> ${linked}::jsonb
      ORDER BY id
      FOR UPDATE`;
    const rows = await tx.ticket.findMany({
      where: { id: { in: locked.map((row) => row.id) }, spaceId: input.spaceId },
    });
    const updated = [];
    for (const row of rows) {
      let current: TicketPullRequest[];
      try {
        current = readStoredTicketPullRequests(row);
      } catch (error) {
        if (!(error instanceof JsonColumnMismatchError)) throw error;
        reportJsonColumnOnce(
          "Skipped a ticket whose linked pull requests are unreadable",
          error.row,
        );
        continue;
      }
      if (!current.some((item) => item.url === url && item.state !== input.state)) continue;
      const next = current.map((item) => (item.url === url ? { url, state: input.state } : item));
      const finishes =
        input.state === "merged" &&
        !isTicketCompletedStatus(coerceTicketStatus(row.status)) &&
        pullRequestsFinishTicket(next);
      const pendingDecision = hasPendingTicketDecision({ decision: readTicketDecision(row) });
      updated.push(
        await tx.ticket.update({
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
        }),
      );
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
