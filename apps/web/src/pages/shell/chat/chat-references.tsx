import type { ChatReferenceContext } from "@rakazo/chat-ui/web";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { getLabs, subscribeLabs } from "../../../lib/bootstrap";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { useBoardStream } from "../../space/use-board-stream";

const RoutineTicketModal = lazy(() =>
  import("./routine-ticket-modal").then((module) => ({ default: module.RoutineTicketModal })),
);

type ChatReferences = {
  /** The Space's board references chat text links, once the board has loaded. */
  referenceContext?: ChatReferenceContext;
  /** Opens a ticket by reference in the board's detail view. */
  openTicket?: (ticketRef: string) => void;
  /** Answers a ticket's open decision from its chat hover card. */
  decideTicket?: (ticketId: string, optionId: string) => void;
};

const ChatReferencesContext = createContext<ChatReferences>({
  referenceContext: undefined,
  openTicket: undefined,
  decideTicket: undefined,
});

/**
 * The Space's board as chat references: its ticket prefix, repositories and tickets, so ticket
 * refs, pull requests and commits in any chat link up. Outside the provider nothing links.
 */
export function ChatReferencesProvider({ children }: { children: ReactNode }) {
  const queries = useSpaceQueries();
  const boardEnabled = useSyncExternalStore(
    subscribeLabs,
    () => getLabs().includes("board"),
    () => false,
  );
  const ticketsOptions = queries.tickets.list.queryOptions({ input: {} });
  const board = useQuery({ ...queries.boards.get.queryOptions(), enabled: boardEnabled });
  const tickets = useQuery({ ...ticketsOptions, enabled: boardEnabled });
  const bots = useQuery({ ...queries.bots.list.queryOptions(), enabled: boardEnabled });
  useBoardStream(ticketsOptions, undefined, boardEnabled);
  const decideSave = useSave<{ ticketId: string; optionId: string }>({
    save: (input, rpc) => rpc.tickets.decide(input),
    stale: [queries.tickets.list.key(), queries.tickets.get.key(), queries.tickets.comments.key()],
  });

  const boardData = board.data;
  const ticketList = tickets.data?.tickets;
  const botNames = useMemo(
    () => new Map((bots.data ?? []).map((bot) => [bot.id, bot.name])),
    [bots.data],
  );
  const referenceContext = useMemo<ChatReferenceContext | undefined>(
    () =>
      boardData
        ? {
            ticketPrefix: boardData.ticketPrefix,
            repositories: boardData.repositories,
            tickets: (ticketList ?? []).map((ticket) => ({
              id: ticket.id,
              ref: ticket.ref,
              title: ticket.title,
              status: ticket.status,
              priority: ticket.priority,
              assigneeName: ticket.assigneeBotId ? botNames.get(ticket.assigneeBotId) : undefined,
              repository: ticket.repository,
              pullRequests: ticket.pullRequests,
              decision: ticket.decision,
            })),
          }
        : undefined,
    [boardData, ticketList, botNames],
  );

  const [openTicketRef, setOpenTicketRef] = useState<string | null>(null);
  const openTicket = useCallback((ticketRef: string) => setOpenTicketRef(ticketRef), []);
  const closeTicket = useCallback(() => setOpenTicketRef(null), []);
  const decideTicket = boardEnabled
    ? (ticketId: string, optionId: string) => decideSave.run({ ticketId, optionId })
    : undefined;
  const value = useMemo(
    () => ({ referenceContext, openTicket: boardEnabled ? openTicket : undefined, decideTicket }),
    [referenceContext, boardEnabled, openTicket, decideTicket],
  );

  return (
    <ChatReferencesContext.Provider value={value}>
      {children}
      {openTicketRef ? (
        <Suspense fallback={null}>
          <RoutineTicketModal ticketRef={openTicketRef} onClose={closeTicket} />
        </Suspense>
      ) : null}
    </ChatReferencesContext.Provider>
  );
}

/** The board's chat references, or none outside the provider. */
export function useChatReferences(): ChatReferences {
  return useContext(ChatReferencesContext);
}

/** Opens a ticket from chat text; undefined when the board is off or outside the provider. */
export function useOpenTicket(): ((ticketRef: string) => void) | undefined {
  return useContext(ChatReferencesContext).openTicket;
}
