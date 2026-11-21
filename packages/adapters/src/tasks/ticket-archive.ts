import type { BoardEvents, PrismaClient } from "@rakazo/db";
import { archiveCompletedTickets, createRetentionPruner } from "@rakazo/db";

/**
 * The reconciler's hourly pass that moves done and closed tickets a week past completion into the
 * archive, then tells each affected board to re-read.
 */
export function createTicketArchiver(deps: {
  prisma: PrismaClient;
  boardEvents: BoardEvents;
}): () => Promise<void> {
  return createRetentionPruner("ticket.archive", async (at) => {
    const { archived, boards } = await archiveCompletedTickets(deps.prisma, at);
    await Promise.all(
      boards.map(({ spaceId, boardId }) => deps.boardEvents.notify(spaceId, { boardId })),
    );
    return archived;
  });
}
