import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Me, Ticket, TicketStatus } from "@rakazo/contracts";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Columns3, Plus } from "lucide-react";
import { useState } from "react";
import { formatRelativeTime } from "../../lib/locale/relative-time";
import { useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { TicketDetailView, TicketEditForm } from "./TicketDetailView";
import { ticketInvolvesBot, ticketMentionsMe, ticketPeopleSummary } from "./ticket-people";
import { useTicketPriorityLabels } from "./ticket-priority";
import { useTicketStatusLabels } from "./ticket-status";
import { useBoardStream } from "./use-board-stream";

const KANBAN_COLUMNS: readonly TicketStatus[] = ["todo", "doing", "review", "blocked", "done"];

export type KanbanModalTarget = "board" | "new" | Ticket;

/**
 * In-chat Kanban modal for inspecting a bot's synced tasks in detail or viewing the full board
 * without leaving the conversation.
 */
export function KanbanModal({
  open,
  target,
  botId,
  botName,
  bots,
  onClose,
}: {
  open: boolean;
  target: KanbanModalTarget | null;
  botId?: string;
  botName?: string;
  bots: Bot[];
  onClose: () => void;
}) {
  const [view, setView] = useState<KanbanModalTarget>(target ?? "board");
  const [scope, setScope] = useState<"bot" | "all">(botId ? "bot" : "all");
  const [streamError, setStreamError] = useState("");
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const meKey = queries.me?.queryKey?.();
  const currentUserId = meKey ? queryClient.getQueryData<Me>(meKey)?.userId : undefined;
  const ticketsOptions = queries.tickets.list.queryOptions({ input: {} });
  const ticketsQuery = useQuery({ ...ticketsOptions, enabled: open });
  useBoardStream(ticketsOptions, setStreamError, open);

  const allTickets = ticketsQuery.data?.tickets ?? [];
  const visibleTickets =
    scope === "bot" && botId
      ? allTickets.filter((ticket) => ticketInvolvesBot(ticket, botId))
      : allTickets;

  // Keep an open ticket synced with live board updates as the bot works.
  const activeTicket =
    typeof view === "object" ? (allTickets.find((item) => item.id === view.id) ?? view) : null;

  const loadError = streamError || (ticketsQuery.error ? errorText(ticketsQuery.error) : "");

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        data-testid="kanban-modal"
        className={`max-h-[85vh] overflow-y-auto overflow-x-hidden ${
          view === "board" ? "sm:max-w-5xl" : "sm:max-w-4xl"
        }`}
      >
        {view === "board" ? (
          <KanbanBoardView
            tickets={visibleTickets}
            bots={bots}
            botId={botId}
            botName={botName}
            currentUserId={currentUserId}
            scope={scope}
            error={loadError}
            onScopeChange={setScope}
            onSelect={(ticket) => setView(ticket)}
            onCreate={() => setView("new")}
          />
        ) : view === "new" ? (
          <TicketEditForm
            ticket={null}
            defaultWorkerIds={botId ? [botId] : []}
            currentUserId={currentUserId}
            bots={bots}
            onBack={() => setView("board")}
            onDone={() => setView("board")}
          />
        ) : activeTicket ? (
          <TicketDetailView
            key={activeTicket.id}
            ticket={activeTicket}
            currentUserId={currentUserId}
            bots={bots}
            onBack={() => setView("board")}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function KanbanBoardView({
  tickets,
  bots,
  botId,
  botName,
  currentUserId,
  scope,
  error,
  onScopeChange,
  onSelect,
  onCreate,
}: {
  tickets: Ticket[];
  bots: Bot[];
  botId?: string;
  botName?: string;
  currentUserId?: string;
  scope: "bot" | "all";
  error: string;
  onScopeChange: (scope: "bot" | "all") => void;
  onSelect: (ticket: Ticket) => void;
  onCreate: () => void;
}) {
  const { t } = useLingui();
  const statuses = useTicketStatusLabels();
  const priorities = useTicketPriorityLabels();
  const peopleLabels = { me: t`Me`, member: t`Member` };

  return (
    <div className="flex flex-col gap-4">
      <DialogHeader className="flex-row items-center justify-between gap-3 pe-6">
        <div className="flex min-w-0 items-center gap-2">
          <Columns3 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <DialogTitle className="truncate">
            {scope === "bot" && botName ? t`${botName} tasks` : t`Kanban board`}
          </DialogTitle>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {botId ? (
            <fieldset
              aria-label={t`Filter tasks`}
              className="inline-flex rounded-md border border-border bg-muted/40 p-0.5"
            >
              <Button
                type="button"
                size="sm"
                variant={scope === "bot" ? "secondary" : "ghost"}
                onClick={() => onScopeChange("bot")}
              >
                <Trans>This bot</Trans>
              </Button>
              <Button
                type="button"
                size="sm"
                variant={scope === "all" ? "secondary" : "ghost"}
                onClick={() => onScopeChange("all")}
              >
                <Trans>All</Trans>
              </Button>
            </fieldset>
          ) : null}
          <Button type="button" size="sm" onClick={onCreate}>
            <Plus className="size-3.5" aria-hidden />
            <Trans>New task</Trans>
          </Button>
        </div>
      </DialogHeader>
      {error ? (
        <p role="alert" className="text-body text-destructive">
          {error}
        </p>
      ) : null}
      <div
        data-testid="kanban-modal-columns"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5"
      >
        {KANBAN_COLUMNS.map((status) => {
          const columnTickets = tickets.filter((ticket) => ticket.status === status);
          return (
            <section
              key={status}
              className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/60 bg-muted/20 p-2.5"
            >
              <header className="flex items-center justify-between gap-2 px-0.5">
                <h3 className="truncate text-body-sm font-medium text-foreground">
                  {statuses[status]}
                </h3>
                <span className="text-label text-muted-foreground">{columnTickets.length}</span>
              </header>
              <div className="flex flex-col gap-1.5">
                {columnTickets.map((ticket) => {
                  const cardPeople = ticketPeopleSummary(ticket, bots, currentUserId, peopleLabels);
                  return (
                    <button
                      key={ticket.id}
                      type="button"
                      data-testid={`kanban-card-${ticket.id}`}
                      onClick={() => onSelect(ticket)}
                      className="flex w-full flex-col items-start gap-1 rounded-md border border-border bg-card p-2.5 text-start transition-colors hover:bg-accent"
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-label text-muted-foreground">
                          <span>{ticket.ref}</span>
                          {ticketMentionsMe(ticket) ? (
                            <span
                              data-testid={`kanban-card-mention-${ticket.id}`}
                              title={t`Needs you`}
                              className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-caption font-bold text-destructive"
                            >
                              !
                            </span>
                          ) : null}
                        </span>
                        {ticket.priority === "high" || ticket.priority === "urgent" ? (
                          <span className="text-label text-warning">
                            {priorities[ticket.priority]}
                          </span>
                        ) : null}
                      </div>
                      <span className="line-clamp-2 text-body-sm text-foreground" dir="auto">
                        {ticket.title}
                      </span>
                      <div className="flex w-full items-center justify-between gap-2 pt-0.5 text-label text-muted-foreground">
                        {cardPeople ? <span className="truncate">{cardPeople}</span> : <span />}
                        <span className="shrink-0">{formatRelativeTime(ticket.updatedAt)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      {tickets.length === 0 && !error ? (
        <p className="py-6 text-center text-body text-muted-foreground">
          <Trans>No tasks yet</Trans>
        </p>
      ) : null}
    </div>
  );
}
