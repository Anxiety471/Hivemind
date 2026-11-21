import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Me, Ticket } from "@rakazo/contracts";
import { TICKET_STATUSES } from "@rakazo/contracts";
import { Button, Dialog, DialogContent } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PageHeader } from "../../components/PageHeader";
import { WindowChrome } from "../../components/WindowChrome";
import { useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { TicketDetailView, TicketEditForm } from "./TicketDetailView";
import { ticketMentionsMe, ticketOwnerLabel, ticketWorkerNames } from "./ticket-people";
import { useTicketStatusLabels } from "./ticket-status";
import { useBoardStream } from "./use-board-stream";

export function BoardPage() {
  const { t } = useLingui();
  const statuses = useTicketStatusLabels();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const meKey = queries.me?.queryKey?.();
  const currentUserId = meKey ? queryClient.getQueryData<Me>(meKey)?.userId : undefined;
  const [showArchive, setShowArchive] = useState(false);
  const ticketsOptions = queries.tickets.list.queryOptions({
    input: showArchive ? { archived: true } : {},
  });
  const ticketsQuery = useQuery(ticketsOptions);
  const botsQuery = useQuery(queries.bots.list.queryOptions());
  const tickets = ticketsQuery.data?.tickets ?? [];
  const bots = botsQuery.data ?? [];
  const [selected, setSelected] = useState<Ticket | "new" | null>(null);
  const [streamError, setError] = useState("");
  const loadFailed = ticketsQuery.error ?? botsQuery.error;
  const error = streamError || (loadFailed ? errorText(loadFailed) : "");
  const ownerLabels = { me: t`Me`, member: t`Member` };

  useBoardStream(ticketsOptions, setError);

  const activeTicket =
    selected && selected !== "new"
      ? (tickets.find((item) => item.id === selected.id) ?? selected)
      : null;

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <PageHeader
        title={showArchive ? <Trans>Archive</Trans> : <Trans>Board</Trans>}
        actions={
          <>
            <Button variant="outline" onClick={() => setShowArchive(!showArchive)}>
              {showArchive ? <Trans>Board</Trans> : <Trans>Archive</Trans>}
            </Button>
            {showArchive ? null : (
              <Button onClick={() => setSelected("new")}>
                <Trans>New ticket</Trans>
              </Button>
            )}
          </>
        }
      />
      {error ? (
        <p role="alert" className="px-4 py-2 text-body text-destructive">
          {error}
        </p>
      ) : null}
      <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
        {/* Narrow screens swipe one comfortable column at a time; wider ones fill the row. */}
        <div
          data-testid="board-columns"
          className="flex min-h-full snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain md:snap-none md:overflow-visible"
        >
          {TICKET_STATUSES.map((status) => (
            <section
              key={status}
              className="w-[280px] shrink-0 snap-start space-y-2 md:w-auto md:min-w-40 md:flex-1"
            >
              <h2 className="px-1 text-body font-medium">{statuses[status]}</h2>
              {tickets
                .filter((ticket) => ticket.status === status)
                .map((ticket) => {
                  const workers = ticketWorkerNames(ticket, bots);
                  const subtitle =
                    workers.length > 0
                      ? workers.join(", ")
                      : ticketOwnerLabel(ticket, bots, currentUserId, ownerLabels);
                  return (
                    <Button
                      key={ticket.id}
                      data-testid={`board-card-${ticket.id}`}
                      variant="outline"
                      className="h-auto w-full flex-col items-start gap-1 whitespace-normal p-3 text-start font-normal"
                      onClick={() => setSelected(ticket)}
                    >
                      <span className="flex items-center gap-1.5 text-label text-muted-foreground">
                        <span>{ticket.ref}</span>
                        {ticketMentionsMe(ticket) ? (
                          <span
                            data-testid={`board-card-mention-${ticket.id}`}
                            title={t`Needs you`}
                            className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-caption font-bold text-destructive"
                          >
                            !
                          </span>
                        ) : null}
                      </span>
                      <span>{ticket.title}</span>
                      <span className="text-label text-muted-foreground">{subtitle}</span>
                    </Button>
                  );
                })}
            </section>
          ))}
        </div>
        {tickets.length === 0 && !error ? (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-body text-muted-foreground">
            <Trans>No tickets yet</Trans>
          </p>
        ) : null}
      </main>
      {selected ? (
        <BoardTicketModal
          key={selected === "new" ? "new" : selected.id}
          ticket={activeTicket}
          currentUserId={currentUserId}
          bots={bots}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}

function BoardTicketModal({
  ticket,
  currentUserId,
  bots,
  onClose,
}: {
  ticket: Ticket | null;
  currentUserId?: string;
  bots: Bot[];
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto overflow-x-hidden sm:max-w-5xl">
        {ticket ? (
          <TicketDetailView
            ticket={ticket}
            currentUserId={currentUserId}
            bots={bots}
            showChatLink
          />
        ) : (
          <TicketEditForm
            ticket={null}
            defaultWorkerIds={[]}
            currentUserId={currentUserId}
            bots={bots}
            onBack={onClose}
            onDone={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
