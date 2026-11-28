import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useSpaceQueries } from "../../../lib/query/query";
import { KanbanModal } from "../../space/KanbanModal";

/** Opens the ticket a chat row names by reference, such as TASK-311, in the board's detail view. */
export function RoutineTicketModal({
  ticketRef,
  onClose,
}: {
  ticketRef: string;
  onClose: () => void;
}) {
  const queries = useSpaceQueries();
  const ticket = useQuery(queries.tickets.get.queryOptions({ input: { ref: ticketRef } }));
  const bots = useQuery(queries.bots.list.queryOptions());
  const failed = ticket.isError;
  // A reference the board does not know has nothing to show.
  useEffect(() => {
    if (failed) onClose();
  }, [failed, onClose]);
  if (!ticket.data) return null;
  return <KanbanModal open target={ticket.data} bots={bots.data ?? []} onClose={onClose} />;
}
