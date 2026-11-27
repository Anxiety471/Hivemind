import { useLingui } from "@lingui/react/macro";
import type { ChatReferenceContext } from "@rakazo/chat-ui/native";
import type { Ticket, TicketStatus } from "@rakazo/contracts";
import { hasLab } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { Alert } from "react-native";
import { selectedSpaceId, subscribeSpaceSelection } from "../api/api";
import {
  currentSessionGeneration,
  loadSessionToken,
  subscribeSessionGeneration,
} from "../api/session";
import { errorText } from "../api/user-error";
import { accountRpcQuery, queryClient, rpcQuery, useSave } from "../query/query";
import { TicketDetailSheet } from "./ticket-detail-sheet";

export type ChatReferences = {
  referenceContext?: ChatReferenceContext;
  openTicket?: (ticketRef: string) => void;
};

export const ChatReferencesContext = createContext<ChatReferences>({});

/** What chat text resolves against, and how a ticket reference opens its sheet. */
export function useChatReferences(): ChatReferences {
  return useContext(ChatReferencesContext);
}

export function useOpenTicket(): ((ticketRef: string) => void) | undefined {
  return useContext(ChatReferencesContext).openTicket;
}

/** Whether the session this render is for has a signed-in user, read once per session. */
function useSignedIn(session: number): boolean {
  const [answer, setAnswer] = useState<{ session: number; signedIn: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    void loadSessionToken().then(
      (token) => {
        if (active) setAnswer({ session, signedIn: Boolean(token) });
      },
      () => {
        if (active) setAnswer({ session, signedIn: false });
      },
    );
    return () => {
      active = false;
    };
  }, [session]);
  return answer?.session === session && answer.signedIn;
}

/**
 * Board references for the chat: the Space's ticket prefix, repositories and tickets resolve
 * ticket refs, pull requests and commits in messages, and a tapped ticket opens its sheet here.
 * Reads happen only for a signed-in user with a Space selected and the board lab on.
 */
export function ChatReferencesProvider({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  const session = useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
  const spaceId = useSyncExternalStore(subscribeSpaceSelection, selectedSpaceId);
  const signedIn = useSignedIn(session);
  const me = useQuery({ ...accountRpcQuery("me"), enabled: signedIn }, queryClient);
  const boardOn = signedIn && Boolean(spaceId) && hasLab(me.data?.labs, "board");
  const boardQuery = useQuery({ ...rpcQuery("boards/get"), enabled: boardOn }, queryClient);
  const ticketsRead = rpcQuery("tickets/list", {});
  const ticketsQuery = useQuery({ ...ticketsRead, enabled: boardOn }, queryClient);
  const tickets = useMemo(
    () => (boardOn ? (ticketsQuery.data?.tickets ?? []) : []),
    [boardOn, ticketsQuery.data],
  );

  const [openTicketRef, setOpenTicketRef] = useState<string | null>(null);
  const listed = openTicketRef
    ? tickets.find((row) => row.ref.toUpperCase() === openTicketRef.toUpperCase())
    : undefined;
  const ticketRead = rpcQuery("tickets/get", { ref: openTicketRef ?? "" });
  const ticketQuery = useQuery(
    { ...ticketRead, enabled: Boolean(openTicketRef) && boardOn && !listed },
    queryClient,
  );
  const ticketError = ticketQuery.error;
  // A ref that does not resolve closes the sheet rather than leaving an empty one open.
  useEffect(() => {
    if (ticketError) setOpenTicketRef(null);
  }, [ticketError]);
  const shownTicket = openTicketRef ? (listed ?? ticketQuery.data ?? null) : null;

  // Keeps the Space's ticket list and the ticket this sheet shows in step with a saved change.
  const applyTicket = (updated: Ticket) => {
    queryClient.setQueryData(ticketsRead.queryKey, (current) =>
      current
        ? {
            tickets: [updated, ...current.tickets.filter((row) => row.id !== updated.id)],
          }
        : current,
    );
    if (openTicketRef) queryClient.setQueryData(ticketRead.queryKey, updated);
  };

  const moveSave = useSave<{ ticket: Ticket; status: TicketStatus }, Ticket>({
    save: ({ ticket, status }, send) => send("tickets/move", { id: ticket.id, status }),
    stale: [ticketsRead.queryKey],
    onSaved: applyTicket,
    onFailed: (cause) => Alert.alert(t`Could not move the ticket`, errorText(cause, t`Try again.`)),
  });

  const decideSave = useSave<
    { ticketId: string; optionId?: string; customAnswer?: string },
    { ticket: Ticket }
  >({
    save: (input, send) => send("tickets/decide", input),
    stale: [ticketsRead.queryKey],
    onSaved: (result) => applyTicket(result.ticket),
    onFailed: (cause) => Alert.alert(t`Could not submit decision`, errorText(cause, t`Try again.`)),
  });

  const openTicket = useCallback((ticketRef: string) => setOpenTicketRef(ticketRef), []);
  const referenceContext = useMemo<ChatReferenceContext | undefined>(
    () =>
      boardOn && boardQuery.data
        ? {
            ticketPrefix: boardQuery.data.ticketPrefix,
            repositories: boardQuery.data.repositories,
            tickets,
          }
        : undefined,
    [boardOn, boardQuery.data, tickets],
  );
  const value = useMemo(() => ({ referenceContext, openTicket }), [referenceContext, openTicket]);

  return (
    <ChatReferencesContext.Provider value={value}>
      {children}
      {shownTicket ? (
        <TicketDetailSheet
          ticket={shownTicket}
          deciding={decideSave.pending}
          onClose={() => setOpenTicketRef(null)}
          onMove={(ticket, status) => moveSave.run({ ticket, status })}
          onDecide={(ticket, input) => decideSave.run({ ticketId: ticket.id, ...input })}
        />
      ) : null}
    </ChatReferencesContext.Provider>
  );
}
