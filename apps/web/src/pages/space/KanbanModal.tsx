import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { Bot, Me, Ticket, TicketPriority, TicketStatus } from "@rakazo/contracts";
import {
  TICKET_COMMENT_MAX_LENGTH,
  TICKET_DESCRIPTION_MAX_LENGTH,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TITLE_MAX_LENGTH,
} from "@rakazo/contracts";
import { writeSaved } from "@rakazo/core/query";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  OptionSelect,
  Textarea,
} from "@rakazo/ui-web";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Columns3, Pencil, Plus } from "lucide-react";
import { useId, useState } from "react";
import { formatRelativeTime } from "../../lib/locale/relative-time";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import {
  OWNER_ME_VALUE,
  ownerOptionValue,
  ownerPayloadFromValue,
  sameIdList,
  ticketInvolvesBot,
  ticketOwnerLabel,
  ticketWorkerIds,
  ticketWorkerNames,
} from "./ticket-people";
import { useTicketPriorityLabels } from "./ticket-priority";
import { useTicketStatusLabels } from "./ticket-status";
import { useBoardStream } from "./use-board-stream";
import { WorkerBotsSelect } from "./WorkerBotsSelect";

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
        className={`max-h-[85vh] overflow-y-auto ${view === "board" ? "sm:max-w-5xl" : "sm:max-w-2xl"}`}
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
  const ownerLabels = { me: t`Me`, member: t`Member` };

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
                  const workers = ticketWorkerNames(ticket, bots);
                  const cardPeople =
                    workers.length > 0
                      ? workers.join(", ")
                      : ticketOwnerLabel(ticket, bots, currentUserId, ownerLabels);
                  return (
                    <button
                      key={ticket.id}
                      type="button"
                      data-testid={`kanban-card-${ticket.id}`}
                      onClick={() => onSelect(ticket)}
                      className="flex w-full flex-col items-start gap-1 rounded-md border border-border bg-card p-2.5 text-start transition-colors hover:bg-accent"
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="text-label text-muted-foreground">{ticket.ref}</span>
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

function TicketDetailView({
  ticket,
  currentUserId,
  bots,
  onBack,
}: {
  ticket: Ticket;
  currentUserId?: string;
  bots: Bot[];
  onBack: () => void;
}) {
  const { t } = useLingui();
  const statuses = useTicketStatusLabels();
  const priorities = useTicketPriorityLabels();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState("");
  const commentsOptions = queries.tickets.comments.queryOptions({
    input: ticket ? { ticketId: ticket.id } : skipToken,
  });
  const commentsQuery = useQuery(commentsOptions);
  const comments = commentsQuery.data ?? [];

  const moving = useSave({
    save: async (status: TicketStatus, rpc) => {
      await rpc.tickets.move({ id: ticket.id, status });
    },
    stale: [queries.tickets.list.key()],
  });

  const commenting = useSave({
    save: async (text: string, rpc) => {
      const row = await rpc.tickets.comment({ ticketId: ticket.id, body: text });
      if (queryClient.getQueryData(commentsOptions.queryKey)) {
        await writeSaved(queryClient, commentsOptions.queryKey, (previous = []) =>
          previous.some((item) => item.id === row.id) ? previous : [...previous, row],
        );
      } else {
        await queryClient.cancelQueries({ queryKey: commentsOptions.queryKey, exact: true });
      }
      setBody("");
    },
    stale: [commentsOptions.queryKey],
  });

  if (editing) {
    return (
      <TicketEditForm
        ticket={ticket}
        defaultWorkerIds={ticketWorkerIds(ticket)}
        currentUserId={currentUserId}
        bots={bots}
        onBack={() => setEditing(false)}
        onDone={() => setEditing(false)}
      />
    );
  }

  const ownerName = ticketOwnerLabel(ticket, bots, currentUserId, {
    me: t`Me`,
    member: t`Member`,
  });
  const workerNames = ticketWorkerNames(ticket, bots);
  const shownError = moving.error
    ? errorText(moving.error)
    : commenting.error
      ? errorText(commenting.error)
      : commentsQuery.error
        ? errorText(commentsQuery.error)
        : "";

  return (
    <div data-testid="kanban-ticket-detail" className="flex flex-col gap-4">
      <DialogHeader className="flex-row items-start justify-between gap-3 pe-6">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="-ms-2 text-muted-foreground"
            >
              <ArrowLeft className="size-3.5" aria-hidden />
              <Trans>Board</Trans>
            </Button>
            <span className="text-label text-muted-foreground">{ticket.ref}</span>
          </div>
          <DialogTitle className="text-start" dir="auto">
            {ticket.title}
          </DialogTitle>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setEditing(true)}
          className="shrink-0"
        >
          <Pencil className="size-3.5" aria-hidden />
          <Trans>Edit</Trans>
        </Button>
      </DialogHeader>

      <div className="flex flex-wrap items-center gap-3 border-b border-border pb-3">
        <div className="w-40">
          <OptionSelect<TicketStatus>
            aria-label={t`Status`}
            size="sm"
            value={ticket.status}
            disabled={moving.pending}
            onValueChange={(next) => {
              if (next !== ticket.status) moving.run(next);
            }}
            options={TICKET_STATUSES.map((value) => ({ value, label: statuses[value] }))}
          />
        </div>
        <span className="text-body-sm text-muted-foreground">{priorities[ticket.priority]}</span>
        {ownerName ? (
          <span className="text-body-sm text-muted-foreground">
            <Trans>Owner: {ownerName}</Trans>
          </span>
        ) : null}
        {workerNames.length > 0 ? (
          <span className="text-body-sm text-muted-foreground">
            <Trans>Workers: {workerNames.join(", ")}</Trans>
          </span>
        ) : null}
        <span className="ms-auto text-body-sm text-faint-foreground">
          {formatRelativeTime(ticket.updatedAt)}
        </span>
      </div>

      {ticket.description?.trim() ? (
        <div className="text-body text-foreground">
          <ChatMarkdown>{ticket.description}</ChatMarkdown>
        </div>
      ) : null}

      <div data-testid="kanban-ticket-comments" className="space-y-3 border-t border-border pt-3">
        {comments.map((row) => (
          <div key={row.id} className="text-body">
            <div className="mb-1 flex items-center justify-between gap-3 text-label text-muted-foreground">
              <span>{row.authorName}</span>
              <time dateTime={row.createdAt}>{formatRelativeTime(row.createdAt)}</time>
            </div>
            <ChatMarkdown>{row.body}</ChatMarkdown>
          </div>
        ))}
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            commenting.run(body);
          }}
        >
          <Textarea
            aria-label={t`Comment`}
            placeholder={t`Add a note`}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={TICKET_COMMENT_MAX_LENGTH}
          />
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={commenting.pending || !body.trim()}>
              <Trans>Comment</Trans>
            </Button>
          </div>
        </form>
      </div>

      {shownError ? (
        <p role="alert" className="text-body text-destructive">
          {shownError}
        </p>
      ) : null}
    </div>
  );
}

function TicketEditForm({
  ticket,
  defaultWorkerIds,
  currentUserId,
  bots,
  onBack,
  onDone,
}: {
  ticket: Ticket | null;
  defaultWorkerIds: string[];
  currentUserId?: string;
  bots: Bot[];
  onBack: () => void;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const formId = useId();
  const statuses = useTicketStatusLabels();
  const priorities = useTicketPriorityLabels();
  const queries = useSpaceQueries();
  const initialOwner = ownerOptionValue(ticket, currentUserId);
  const initialWorkers = ticket ? ticketWorkerIds(ticket) : defaultWorkerIds;
  const [title, setTitle] = useState(ticket?.title ?? "");
  const [description, setDescription] = useState(ticket?.description ?? "");
  const [owner, setOwner] = useState(initialOwner);
  const [workerBotIds, setWorkerBotIds] = useState<string[]>(initialWorkers);
  const [status, setStatus] = useState<TicketStatus>(ticket?.status ?? "todo");
  const [priority, setPriority] = useState<TicketPriority>(ticket?.priority ?? "normal");

  const ownerOptions = [
    { value: OWNER_ME_VALUE, label: t`Me` },
    ...bots.map((bot) => ({ value: `bot:${bot.id}`, label: bot.name })),
  ];
  if (owner && owner !== OWNER_ME_VALUE && !ownerOptions.some((option) => option.value === owner)) {
    ownerOptions.unshift({ value: owner, label: t`Member` });
  }

  const saving = useSave({
    save: async (_input, rpc) => {
      if (ticket) {
        const ownerPatch = ownerPayloadFromValue(owner, currentUserId);
        await rpc.tickets.update({
          id: ticket.id,
          ...(title !== ticket.title ? { title } : {}),
          ...(description !== (ticket.description ?? "") ? { description } : {}),
          ...(owner !== initialOwner ? ownerPatch : {}),
          ...(!sameIdList(workerBotIds, initialWorkers) ? { workerBotIds } : {}),
          ...(status !== ticket.status ? { status } : {}),
          ...(priority !== ticket.priority ? { priority } : {}),
        });
      } else {
        await rpc.tickets.create({
          title,
          description,
          ...ownerPayloadFromValue(OWNER_ME_VALUE, currentUserId),
          workerBotIds,
          priority,
        });
      }
    },
    stale: [queries.tickets.list.key()],
    closesScreen: true,
    onSaved: () => onDone(),
  });

  return (
    <div className="flex flex-col gap-4">
      <DialogHeader className="flex-row items-center gap-2 pe-6">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="-ms-2 text-muted-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          {ticket ? t`Back` : t`Board`}
        </Button>
        <DialogTitle>{ticket ? ticket.ref : t`New task`}</DialogTitle>
      </DialogHeader>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          saving.run();
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${formId}-title`}>
              <Trans>Title</Trans>
            </FieldLabel>
            <Input
              id={`${formId}-title`}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={TICKET_TITLE_MAX_LENGTH}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${formId}-description`}>
              <Trans>Description</Trans>
            </FieldLabel>
            <Textarea
              id={`${formId}-description`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={TICKET_DESCRIPTION_MAX_LENGTH}
            />
          </Field>
          {ticket ? (
            <Field>
              <FieldLabel htmlFor={`${formId}-owner`}>
                <Trans>Owner</Trans>
              </FieldLabel>
              <OptionSelect
                id={`${formId}-owner`}
                value={owner}
                onValueChange={setOwner}
                options={ownerOptions}
              />
            </Field>
          ) : null}
          <Field>
            <FieldLabel htmlFor={`${formId}-workers`}>
              <Trans>Workers</Trans>
            </FieldLabel>
            <WorkerBotsSelect
              id={`${formId}-workers`}
              bots={bots}
              value={workerBotIds}
              onChange={setWorkerBotIds}
              disabled={saving.pending}
            />
          </Field>
          {ticket ? (
            <Field>
              <FieldLabel htmlFor={`${formId}-status`}>
                <Trans>Status</Trans>
              </FieldLabel>
              <OptionSelect<TicketStatus>
                id={`${formId}-status`}
                value={status}
                onValueChange={setStatus}
                options={TICKET_STATUSES.map((value) => ({ value, label: statuses[value] }))}
              />
            </Field>
          ) : null}
          <Field>
            <FieldLabel htmlFor={`${formId}-priority`}>
              <Trans>Priority</Trans>
            </FieldLabel>
            <OptionSelect<TicketPriority>
              id={`${formId}-priority`}
              value={priority}
              onValueChange={setPriority}
              options={TICKET_PRIORITIES.map((value) => ({ value, label: priorities[value] }))}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onBack}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" disabled={saving.pending || !title.trim()}>
              {ticket ? t`Save` : t`Create`}
            </Button>
          </div>
        </FieldGroup>
      </form>
      {saving.error ? (
        <p role="alert" className="text-body text-destructive">
          {errorText(saving.error)}
        </p>
      ) : null}
    </div>
  );
}
