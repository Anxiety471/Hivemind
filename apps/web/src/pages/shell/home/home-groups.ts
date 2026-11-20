import type { Ticket, TicketStatus } from "@rakazo/contracts";

const IN_PROGRESS: readonly TicketStatus[] = ["doing", "review", "blocked"];
const CLOSED: readonly TicketStatus[] = ["done", "closed"];

function newestFirst(a: Ticket, b: Ticket): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

/** A bot's tickets in the three stages the Home panel shows, most recently touched first. */
export function homeGroups(tickets: Ticket[]): {
  inProgress: Ticket[];
  planned: Ticket[];
  closed: Ticket[];
} {
  const inStage = (statuses: readonly TicketStatus[]) =>
    tickets.filter((ticket) => statuses.includes(ticket.status)).sort(newestFirst);
  return { inProgress: inStage(IN_PROGRESS), planned: inStage(["todo"]), closed: inStage(CLOSED) };
}
