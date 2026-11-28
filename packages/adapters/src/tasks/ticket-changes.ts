import type { JobPublisher, RealtimeFanout } from "@rakazo/adapter-kit";
import type { LabFeature } from "@rakazo/contracts";
import type { BoardEvents, PrismaClient } from "@rakazo/db";
import { retireWaitingQuestionsForTicket } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
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
  /**
   * The ticket was decided, closed or cleared: a chat question still waiting on it is answered
   * with `answer` and its run retired, so the chat card does not stay open.
   */
  settledChatQuestion?: { ticketRef: string; answer: string };
};
export type TicketChangeNotifier = (change: TicketChange) => Promise<void>;

export function createTicketChangeNotifier(deps: {
  boardEvents: BoardEvents;
  prisma: PrismaClient;
  jobs: JobPublisher;
  realtime?: RealtimeFanout;
  deploymentLabs?: readonly LabFeature[];
}): TicketChangeNotifier {
  return async (change) => {
    await deps.boardEvents
      .notify(change.spaceId, {
        boardId: change.boardId,
        ticketId: change.ticketId,
      })
      .catch(() => undefined);
    if (change.settledChatQuestion)
      await bestEffort(
        "retire the chat questions about a settled ticket",
        retireWaitingQuestionsForTicket(
          deps.prisma,
          { spaceId: change.spaceId, ...change.settledChatQuestion },
          deps.realtime,
        ),
      );
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
