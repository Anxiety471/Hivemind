import type { JobPublisher } from "@rakazo/adapter-kit";
import type { LabFeature } from "@rakazo/contracts";
import type { BoardEvents, PrismaClient } from "@rakazo/db";
import { dispatchTicketWakeViaGo } from "./ticket-queue.js";
import { wakeTicketAssignee } from "./ticket-wake.js";

export type TicketChange = {
  spaceId: string;
  boardId: string;
  ticketId: string;
  assigneeBotId: string | null;
  wakeAssignee: boolean;
  wakeBotIds?: string[];
  /** What changed, appended to the wake prompt so the bot sees it before it reads the ticket. */
  wakeNote?: string;
};
export type TicketChangeNotifier = (change: TicketChange) => Promise<void>;

export function createTicketChangeNotifier(deps: {
  boardEvents: BoardEvents;
  prisma: PrismaClient;
  jobs: JobPublisher;
  deploymentLabs?: readonly LabFeature[];
}): TicketChangeNotifier {
  return async (change) => {
    await deps.boardEvents
      .notify(change.spaceId, {
        boardId: change.boardId,
        ticketId: change.ticketId,
      })
      .catch(() => undefined);
    const botIds =
      change.wakeBotIds !== undefined
        ? [...new Set(change.wakeBotIds.filter(Boolean))]
        : change.wakeAssignee && change.assigneeBotId
          ? [change.assigneeBotId]
          : [];
    for (const botId of botIds) {
      const dispatched = await dispatchTicketWakeViaGo({
        spaceId: change.spaceId,
        ticketId: change.ticketId,
        botId,
        note: change.wakeNote,
      });
      if (!dispatched) {
        await wakeTicketAssignee(deps, {
          spaceId: change.spaceId,
          ticketId: change.ticketId,
          botId,
          note: change.wakeNote,
        });
      }
    }
  };
}
