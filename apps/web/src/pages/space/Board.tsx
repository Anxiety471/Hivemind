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
  buttonVariants,
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
import { MessageCircle } from "lucide-react";
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { IconTooltip } from "../../components/IconTooltip";
import { PageHeader } from "../../components/PageHeader";
import { WindowChrome } from "../../components/WindowChrome";
import { formatRelativeTime } from "../../lib/locale/relative-time";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import {
  OWNER_ME_VALUE,
  ownerOptionValue,
  ownerPayloadFromValue,
  sameIdList,
  ticketOwnerLabel,
  ticketWorkerIds,
  ticketWorkerNames,
} from "./ticket-people";
import { useTicketPriorityLabels } from "./ticket-priority";
import { useTicketStatusLabels } from "./ticket-status";
import { useBoardStream } from "./use-board-stream";
import { WorkerBotsSelect } from "./WorkerBotsSelect";

export function BoardPage() {
  const { t } = useLingui();
  const statuses = useTicketStatusLabels();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const meKey = queries.me?.queryKey?.();
  const currentUserId = meKey ? queryClient.getQueryData<Me>(meKey)?.userId : undefined;
  const ticketsOptions = queries.tickets.list.queryOptions({ input: {} });
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

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <PageHeader
        title={<Trans>Board</Trans>}
        actions={
          <Button onClick={() => setSelected("new")}>
            <Trans>New ticket</Trans>
          </Button>
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
                      <span className="text-label text-muted-foreground">{ticket.ref}</span>
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
        <TicketDialog
          key={selected === "new" ? "new" : selected.id}
          ticket={selected === "new" ? null : selected}
          currentUserId={currentUserId}
          bots={bots}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}

function TicketDialog({
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
  const { t } = useLingui();
  const formId = useId();
  const statuses = useTicketStatusLabels();
  const priorities = useTicketPriorityLabels();
  const initialOwner = ownerOptionValue(ticket, currentUserId);
  const initialWorkers = ticket ? ticketWorkerIds(ticket) : [];
  const [title, setTitle] = useState(ticket?.title ?? "");
  const [description, setDescription] = useState(ticket?.description ?? "");
  const [owner, setOwner] = useState(initialOwner);
  const [workerBotIds, setWorkerBotIds] = useState<string[]>(initialWorkers);
  const [status, setStatus] = useState<TicketStatus>(ticket?.status ?? "todo");
  const [priority, setPriority] = useState<TicketPriority>(ticket?.priority ?? "normal");
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const commentsOptions = queries.tickets.comments.queryOptions({
    input: ticket ? { ticketId: ticket.id } : skipToken,
  });
  const commentsQuery = useQuery(commentsOptions);
  const comments = commentsQuery.data ?? [];
  const [body, setBody] = useState("");
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
    onSaved: () => onClose(),
  });
  const commenting = useSave({
    save: async (text: string, rpc) => {
      if (!ticket) return;
      const row = await rpc.tickets.comment({ ticketId: ticket.id, body: text });
      // A list already on screen shows the comment at once, unless a read already brought it.
      if (queryClient.getQueryData(commentsOptions.queryKey)) {
        await writeSaved(queryClient, commentsOptions.queryKey, (previous = []) =>
          previous.some((item) => item.id === row.id) ? previous : [...previous, row],
        );
      } else {
        // A first read still in flight was sent before the post, so it is not waited for.
        await queryClient.cancelQueries({ queryKey: commentsOptions.queryKey, exact: true });
      }
      // Listed now, so the box empties before the list is read again.
      setBody("");
    },
    stale: [commentsOptions.queryKey],
  });
  const ownerBot = owner.startsWith("bot:")
    ? bots.find((bot) => bot.id === owner.slice(4))
    : undefined;
  const primaryWorkerBot = workerBotIds[0]
    ? bots.find((bot) => bot.id === workerBotIds[0])
    : undefined;
  const chatBot = primaryWorkerBot ?? ownerBot;
  const busy = saving.pending || commenting.pending;
  const failure = saving.error ?? commenting.error;
  const shownError = failure
    ? errorText(failure)
    : commentsQuery.error
      ? errorText(commentsQuery.error)
      : "";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{ticket?.title ?? t`New ticket`}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            commenting.reset();
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
                data-testid="ticket-description"
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
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <WorkerBotsSelect
                    id={`${formId}-workers`}
                    bots={bots}
                    value={workerBotIds}
                    onChange={setWorkerBotIds}
                    disabled={busy}
                  />
                </div>
                {chatBot ? (
                  <IconTooltip label={t`Chat with ${chatBot.name}`}>
                    <Link
                      to={`/app/${chatBot.id}`}
                      aria-label={t`Chat with ${chatBot.name}`}
                      className={buttonVariants({
                        variant: "ghost",
                        size: "icon",
                        className: "text-muted-foreground",
                      })}
                    >
                      <MessageCircle />
                    </Link>
                  </IconTooltip>
                ) : null}
              </div>
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
            <div className="flex justify-end">
              <Button type="submit" disabled={busy || !title.trim()}>
                {ticket ? t`Save` : t`Create`}
              </Button>
            </div>
          </FieldGroup>
        </form>
        {ticket ? (
          <div data-testid="ticket-comments" className="space-y-3 border-t pt-3">
            {comments.map((row) => (
              <div key={row.id} className="text-body">
                <div className="mb-1 flex items-center justify-between gap-3 text-label text-muted-foreground">
                  {row.authorBotId && bots.some((bot) => bot.id === row.authorBotId) ? (
                    <Link to={`/app/${row.authorBotId}`} className="hover:text-foreground">
                      {row.authorName}
                    </Link>
                  ) : (
                    <span>{row.authorName}</span>
                  )}
                  <time dateTime={row.createdAt}>{formatRelativeTime(row.createdAt)}</time>
                </div>
                <ChatMarkdown>{row.body}</ChatMarkdown>
              </div>
            ))}
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                saving.reset();
                commenting.run(body);
              }}
            >
              <Textarea
                aria-label={t`Comment`}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                maxLength={TICKET_COMMENT_MAX_LENGTH}
              />
              <div className="flex justify-end">
                <Button type="submit" disabled={busy || !body.trim()}>
                  <Trans>Comment</Trans>
                </Button>
              </div>
            </form>
          </div>
        ) : null}
        {shownError ? (
          <p role="alert" className="text-body text-destructive">
            {shownError}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
