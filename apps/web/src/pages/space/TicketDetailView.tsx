import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type {
  Bot,
  Ticket,
  TicketIssueState,
  TicketPriority,
  TicketPullRequestState,
  TicketStatus,
} from "@rakazo/contracts";
import {
  hasPendingTicketDecision,
  normalizeIssueUrl,
  normalizePullRequestUrl,
  normalizeRepositoryUrl,
  TICKET_COMMENT_MAX_LENGTH,
  TICKET_DECISION_ANSWER_MAX_LENGTH,
  TICKET_DESCRIPTION_MAX_LENGTH,
  TICKET_MAX_ISSUES,
  TICKET_MAX_PULL_REQUESTS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TITLE_MAX_LENGTH,
  ticketLinkLabel,
} from "@rakazo/contracts";
import { writeSaved } from "@rakazo/core/query";
import {
  Button,
  buttonVariants,
  DialogHeader,
  DialogTitle,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  OptionSelect,
  Textarea,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  CircleCheck,
  CircleDot,
  FolderGit2,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  MessageCircle,
  Pencil,
  Plus,
  Reply,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { Link, useInRouterContext } from "react-router-dom";
import { IconTooltip } from "../../components/IconTooltip";
import { OptionRow, optionLetter } from "../../components/messages/OptionRow";
import { formatRelativeTime } from "../../lib/locale/relative-time";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import {
  OWNER_ME_VALUE,
  ownerOptionValue,
  ownerPayloadFromValue,
  sameIdList,
  ticketPeopleSummary,
  ticketWorkerIds,
} from "./ticket-people";
import { useTicketPriorityLabels } from "./ticket-priority";
import { useTicketStatusLabels } from "./ticket-status";
import { WorkerBotsSelect } from "./WorkerBotsSelect";

function oneLineExcerpt(text: string, maxChars = 120): string {
  const cleaned = text
    .replace(/^>\s*[^\n]*\n+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1)}…`;
}

/** A pull request or issue icon that shows its state; merged reads as done. */
function LinkStateIcon({
  kind,
  state,
}: {
  kind: "pullRequest" | "issue";
  state: TicketPullRequestState | TicketIssueState;
}) {
  if (kind === "issue") {
    return state === "closed" ? (
      <CircleCheck className="size-4 text-muted-foreground" aria-hidden />
    ) : (
      <CircleDot className="size-4 text-foreground" aria-hidden />
    );
  }
  if (state === "merged") return <GitMerge className="size-4 text-success" aria-hidden />;
  if (state === "closed") {
    return <GitPullRequestClosed className="size-4 text-muted-foreground" aria-hidden />;
  }
  return <GitPullRequest className="size-4 text-foreground" aria-hidden />;
}

function TicketLinkRow({
  url,
  icon,
  state,
  unlinkLabel,
  disabled,
  onUnlink,
}: {
  url: string;
  icon: ReactNode;
  state?: string;
  unlinkLabel: string;
  disabled: boolean;
  onUnlink: () => void;
}) {
  return (
    <li className="group flex min-w-0 items-center gap-1 rounded-md hover:bg-muted/50">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={url}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-body-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex shrink-0">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{ticketLinkLabel(url)}</span>
        {state ? <span className="shrink-0 text-label text-muted-foreground">{state}</span> : null}
      </a>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={unlinkLabel}
        disabled={disabled}
        className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        onClick={onUnlink}
      >
        <X className="size-3" aria-hidden />
      </Button>
    </li>
  );
}

/**
 * Calm, read-first view of a single task: structured 3-choice (+ Other) decision card and
 * description on the left, with comments and reply composer in the side panel.
 */
export function TicketDetailView({
  ticket,
  currentUserId,
  bots,
  showChatLink = false,
  onBack,
  onDone,
}: {
  ticket: Ticket;
  currentUserId?: string;
  bots: Bot[];
  showChatLink?: boolean;
  onBack?: () => void;
  onDone?: () => void;
}) {
  const { t } = useLingui();
  const statuses = useTicketStatusLabels();
  const priorities = useTicketPriorityLabels();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const inRouter = useInRouterContext();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState("");
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");
  const [replyToCommentId, setReplyToCommentId] = useState<string | null>(null);
  const [linkDraft, setLinkDraft] = useState("");
  const [linkError, setLinkError] = useState("");
  const [addingLink, setAddingLink] = useState(false);
  function closeLinkForm() {
    setLinkDraft("");
    setLinkError("");
    setAddingLink(false);
  }

  const commentsOptions = queries.tickets.comments.queryOptions({
    input: { ticketId: ticket.id },
  });
  const commentsQuery = useQuery(commentsOptions);
  const comments = commentsQuery.data ?? [];
  const replyTarget = replyToCommentId
    ? comments.find((item) => item.id === replyToCommentId)
    : undefined;

  const moving = useSave({
    save: async (status: TicketStatus, rpc) => {
      await rpc.tickets.move({ id: ticket.id, status });
    },
    stale: [queries.tickets.list.key()],
  });

  const deciding = useSave({
    save: async (input: { optionId?: string; customAnswer?: string }, rpc) => {
      const result = await rpc.tickets.decide({ ticketId: ticket.id, ...input });
      if (queryClient.getQueryData(commentsOptions.queryKey)) {
        await writeSaved(queryClient, commentsOptions.queryKey, (previous = []) =>
          previous.some((item) => item.id === result.comment.id)
            ? previous
            : [...previous, result.comment],
        );
      } else {
        await queryClient.cancelQueries({ queryKey: commentsOptions.queryKey, exact: true });
      }
      setOtherOpen(false);
      setOtherText("");
    },
    stale: [commentsOptions.queryKey, queries.tickets.list.key()],
  });

  const commenting = useSave({
    save: async (text: string, rpc) => {
      const trimmed = text.trim();
      const formatted = replyTarget
        ? `> In reply to ${replyTarget.authorName || t`Comment`}: "${oneLineExcerpt(replyTarget.body, 140)}"\n\n${trimmed}`.slice(
            0,
            TICKET_COMMENT_MAX_LENGTH,
          )
        : trimmed;
      const row = await rpc.tickets.comment({ ticketId: ticket.id, body: formatted });
      if (queryClient.getQueryData(commentsOptions.queryKey)) {
        await writeSaved(queryClient, commentsOptions.queryKey, (previous = []) =>
          previous.some((item) => item.id === row.id) ? previous : [...previous, row],
        );
      } else {
        await queryClient.cancelQueries({ queryKey: commentsOptions.queryKey, exact: true });
      }
      setBody("");
      setReplyToCommentId(null);
    },
    stale: [commentsOptions.queryKey, queries.tickets.list.key()],
  });

  const linking = useSave({
    save: async (
      input: { pullRequests?: string[]; issues?: string[]; repository?: string | null },
      rpc,
    ) => {
      await rpc.tickets.update({
        id: ticket.id,
        ...(input.pullRequests ? { pullRequests: input.pullRequests.map((url) => ({ url })) } : {}),
        ...(input.issues ? { issues: input.issues.map((url) => ({ url })) } : {}),
        ...(input.repository !== undefined ? { repository: input.repository } : {}),
      });
    },
    stale: [queries.tickets.list.key()],
    onSaved: closeLinkForm,
  });

  function addLink() {
    const pullRequestUrl = normalizePullRequestUrl(linkDraft);
    const issueUrl = pullRequestUrl ? null : normalizeIssueUrl(linkDraft);
    const repositoryUrl = pullRequestUrl || issueUrl ? null : normalizeRepositoryUrl(linkDraft);
    if (!pullRequestUrl && !issueUrl && !repositoryUrl) {
      setLinkError(t`Use a pull request, issue, or repository link.`);
      return;
    }
    setLinkError("");
    if (pullRequestUrl) {
      const urls = ticket.pullRequests.map((item) => item.url);
      if (urls.includes(pullRequestUrl) || urls.length >= TICKET_MAX_PULL_REQUESTS) {
        closeLinkForm();
        return;
      }
      linking.run({ pullRequests: [...urls, pullRequestUrl] });
      return;
    }
    if (issueUrl) {
      const urls = ticket.issues.map((item) => item.url);
      if (urls.includes(issueUrl) || urls.length >= TICKET_MAX_ISSUES) {
        closeLinkForm();
        return;
      }
      linking.run({ issues: [...urls, issueUrl] });
      return;
    }
    if (repositoryUrl === ticket.repository) {
      closeLinkForm();
      return;
    }
    linking.run({ repository: repositoryUrl });
  }

  if (editing) {
    return (
      <TicketEditForm
        ticket={ticket}
        defaultWorkerIds={ticketWorkerIds(ticket)}
        currentUserId={currentUserId}
        bots={bots}
        onBack={() => setEditing(false)}
        onDone={() => {
          setEditing(false);
          onDone?.();
        }}
      />
    );
  }

  const people = ticketPeopleSummary(ticket, bots, currentUserId, {
    me: t`Me`,
    member: t`Member`,
  });
  const primaryWorkerId = ticketWorkerIds(ticket)[0];
  const chatBot =
    (primaryWorkerId ? bots.find((bot) => bot.id === primaryWorkerId) : undefined) ??
    (ticket.ownerBotId ? bots.find((bot) => bot.id === ticket.ownerBotId) : undefined);

  // Only a decision the board stored is shown; the UI never invents choices for a ticket.
  const pendingDecision = hasPendingTicketDecision(ticket) ? ticket.decision : undefined;
  const answeredDecision = ticket.decision?.answer ? ticket.decision : undefined;
  const newestComments = [...comments].reverse();
  const busy = moving.pending || deciding.pending || commenting.pending;
  const linkStates: Record<TicketPullRequestState | TicketIssueState, string> = {
    open: t`Open`,
    merged: t`Merged`,
    closed: t`Closed`,
  };
  const repository = ticket.repository;
  const hasLinks =
    repository !== null || ticket.pullRequests.length > 0 || ticket.issues.length > 0;
  const canAddLink =
    ticket.pullRequests.length < TICKET_MAX_PULL_REQUESTS ||
    ticket.issues.length < TICKET_MAX_ISSUES ||
    !repository;

  const shownError = moving.error
    ? errorText(moving.error)
    : deciding.error
      ? errorText(deciding.error)
      : commenting.error
        ? errorText(commenting.error)
        : linking.error
          ? errorText(linking.error)
          : commentsQuery.error
            ? errorText(commentsQuery.error)
            : "";

  return (
    <div data-testid="kanban-ticket-detail" className="flex min-w-0 flex-col gap-4 overflow-hidden">
      <DialogHeader className="flex-row items-start justify-between gap-3 pe-8">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            {onBack ? (
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
            ) : null}
            <span className="text-label font-medium text-muted-foreground">{ticket.ref}</span>
          </div>
          <DialogTitle className="text-start text-heading3 leading-snug font-semibold" dir="auto">
            {ticket.title}
          </DialogTitle>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {showChatLink && inRouter && chatBot ? (
            <IconTooltip label={t`Chat with ${chatBot.name}`}>
              <Link
                to={`/app/${chatBot.id}`}
                aria-label={t`Chat with ${chatBot.name}`}
                className={buttonVariants({
                  variant: "ghost",
                  size: "icon-sm",
                  className: "text-muted-foreground",
                })}
              >
                <MessageCircle className="size-4" aria-hidden />
              </Link>
            </IconTooltip>
          ) : null}
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
        </div>
      </DialogHeader>

      <div className="flex flex-wrap items-center gap-2.5 border-b border-border/60 pb-3">
        <div className="w-auto">
          <OptionSelect<TicketStatus>
            aria-label={t`Status`}
            size="sm"
            value={ticket.status}
            disabled={busy}
            className="w-auto border-transparent bg-muted/50 hover:bg-muted"
            onValueChange={(next) => {
              if (next !== ticket.status) moving.run(next);
            }}
            options={TICKET_STATUSES.map((value) => ({ value, label: statuses[value] }))}
          />
        </div>
        {ticket.priority === "high" || ticket.priority === "urgent" ? (
          <span className="rounded-md bg-warning/10 px-2 py-0.5 text-label font-medium text-warning">
            {priorities[ticket.priority]}
          </span>
        ) : null}
        {people ? <span className="text-body-sm text-muted-foreground">{people}</span> : null}
        <span className="ms-auto text-label text-faint-foreground">
          {formatRelativeTime(ticket.updatedAt)}
        </span>
      </div>

      <div className="grid min-w-0 grid-cols-1 items-start gap-4 md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
          {pendingDecision ? (
            <section
              data-testid="ticket-decision-card"
              className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-muted/25 p-4"
            >
              <span className="text-label font-medium text-muted-foreground">
                <Trans>Needs your decision</Trans>
              </span>
              <p className="text-body font-medium text-foreground" dir="auto">
                {pendingDecision.question}
              </p>
              <div className="space-y-0.5">
                {pendingDecision.options.map((option, index) => (
                  <OptionRow
                    key={option.id}
                    letter={optionLetter(index)}
                    disabled={busy}
                    badge={
                      option.recommended ? (
                        <span className="shrink-0 rounded-full border border-border bg-background px-2 py-0.5 text-caption font-medium text-foreground">
                          <Trans>Recommended</Trans>
                        </span>
                      ) : undefined
                    }
                    onClick={() => deciding.run({ optionId: option.id })}
                  >
                    {option.label}
                  </OptionRow>
                ))}
                <OptionRow
                  letter={optionLetter(pendingDecision.options.length)}
                  selected={otherOpen}
                  disabled={busy}
                  onClick={() => setOtherOpen((prev) => !prev)}
                >
                  <Trans>Other</Trans>
                </OptionRow>
              </div>
              {otherOpen ? (
                <form
                  className="mt-1 flex flex-col gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (otherText.trim()) deciding.run({ customAnswer: otherText.trim() });
                  }}
                >
                  <Textarea
                    aria-label={t`Custom decision`}
                    placeholder={t`Type your own decision or instructions…`}
                    value={otherText}
                    onChange={(event) => setOtherText(event.target.value)}
                    maxLength={TICKET_DECISION_ANSWER_MAX_LENGTH}
                    disabled={busy}
                    autoFocus
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setOtherOpen(false)}
                    >
                      <Trans>Cancel</Trans>
                    </Button>
                    <Button type="submit" size="sm" disabled={busy || !otherText.trim()}>
                      <Trans>Submit</Trans>
                    </Button>
                  </div>
                </form>
              ) : null}
            </section>
          ) : answeredDecision ? (
            <div
              data-testid="ticket-decision-answered"
              className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/15 px-3 py-2 text-body-sm text-muted-foreground"
            >
              <Check className="size-4 shrink-0 text-success" aria-hidden />
              <span className="min-w-0 truncate" dir="auto">
                <Trans>Answered: {answeredDecision.answer}</Trans>
              </span>
            </div>
          ) : null}

          {ticket.description?.trim() ? (
            <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border/60 bg-muted/15 p-3.5">
              <span className="text-label font-medium text-muted-foreground">
                <Trans>Description</Trans>
              </span>
              <div
                data-testid="ticket-description"
                className="min-w-0 overflow-x-auto text-body leading-relaxed text-foreground [&_pre]:max-w-full [&_pre]:overflow-x-auto"
              >
                <ChatMarkdown>{ticket.description}</ChatMarkdown>
              </div>
            </div>
          ) : null}

          {hasLinks || addingLink ? (
            <section className="flex min-w-0 flex-col rounded-lg border border-border/60 bg-muted/15 p-2">
              <div className="mb-0.5 flex min-h-6 items-center justify-between gap-2 ps-1.5">
                <span className="text-label font-medium text-muted-foreground">
                  <Trans>Links</Trans>
                </span>
                {canAddLink && !addingLink ? (
                  <IconTooltip label={t`Add link`}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t`Add link`}
                      onClick={() => setAddingLink(true)}
                    >
                      <Plus className="size-3.5" aria-hidden />
                    </Button>
                  </IconTooltip>
                ) : null}
              </div>
              {repository ? (
                <ul data-testid="ticket-repository" className="flex min-w-0 flex-col">
                  <TicketLinkRow
                    url={repository}
                    icon={<FolderGit2 className="size-4 text-muted-foreground" aria-hidden />}
                    unlinkLabel={t`Unlink repository`}
                    disabled={linking.pending}
                    onUnlink={() => linking.run({ repository: null })}
                  />
                </ul>
              ) : null}
              {ticket.pullRequests.length > 0 ? (
                <ul data-testid="ticket-pull-requests" className="flex min-w-0 flex-col">
                  {ticket.pullRequests.map((pullRequest) => (
                    <TicketLinkRow
                      key={pullRequest.url}
                      url={pullRequest.url}
                      icon={<LinkStateIcon kind="pullRequest" state={pullRequest.state} />}
                      state={
                        pullRequest.state === "open" ? undefined : linkStates[pullRequest.state]
                      }
                      unlinkLabel={t`Unlink pull request`}
                      disabled={linking.pending}
                      onUnlink={() =>
                        linking.run({
                          pullRequests: ticket.pullRequests
                            .filter((item) => item.url !== pullRequest.url)
                            .map((item) => item.url),
                        })
                      }
                    />
                  ))}
                </ul>
              ) : null}
              {ticket.issues.length > 0 ? (
                <ul data-testid="ticket-issues" className="flex min-w-0 flex-col">
                  {ticket.issues.map((issue) => (
                    <TicketLinkRow
                      key={issue.url}
                      url={issue.url}
                      icon={<LinkStateIcon kind="issue" state={issue.state} />}
                      state={issue.state === "open" ? undefined : linkStates[issue.state]}
                      unlinkLabel={t`Unlink issue`}
                      disabled={linking.pending}
                      onUnlink={() =>
                        linking.run({
                          issues: ticket.issues
                            .filter((item) => item.url !== issue.url)
                            .map((item) => item.url),
                        })
                      }
                    />
                  ))}
                </ul>
              ) : null}
              {addingLink ? (
                <form
                  className="flex flex-col gap-1.5 p-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    addLink();
                  }}
                >
                  <div className="flex items-center gap-2">
                    <Input
                      size="sm"
                      inputMode="url"
                      aria-label={t`Ticket link`}
                      placeholder={t`Paste a link`}
                      value={linkDraft}
                      onChange={(event) => {
                        setLinkDraft(event.target.value);
                        setLinkError("");
                      }}
                      disabled={linking.pending}
                      autoFocus
                    />
                    <Button type="submit" size="sm" disabled={linking.pending || !linkDraft.trim()}>
                      <Trans>Add</Trans>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={linking.pending}
                      onClick={closeLinkForm}
                    >
                      <Trans>Cancel</Trans>
                    </Button>
                  </div>
                  {linkError ? (
                    <p role="alert" className="text-label text-destructive">
                      {linkError}
                    </p>
                  ) : null}
                </form>
              ) : null}
            </section>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ms-2 self-start text-muted-foreground"
              onClick={() => setAddingLink(true)}
            >
              <Plus className="size-3.5" aria-hidden />
              <Trans>Add link</Trans>
            </Button>
          )}
        </div>

        <aside
          data-testid="kanban-comment-panel"
          className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-muted/20 p-3.5 md:sticky md:top-0"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-label font-medium text-muted-foreground">
              <Trans>Comments</Trans>
            </span>
            {newestComments.length > 0 ? (
              <span className="text-label text-faint-foreground">{newestComments.length}</span>
            ) : null}
          </div>

          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              commenting.run(body);
            }}
          >
            {replyTarget ? (
              <div className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-2.5 py-1 text-label text-muted-foreground">
                <span className="truncate">
                  <Trans>Replying to {replyTarget.authorName || t`Comment`}</Trans>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t`Clear reply`}
                  onClick={() => setReplyToCommentId(null)}
                >
                  <X className="size-3" aria-hidden />
                </Button>
              </div>
            ) : null}
            <Textarea
              aria-label={t`Comment`}
              placeholder={t`Add a comment…`}
              rows={2}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={TICKET_COMMENT_MAX_LENGTH}
              disabled={busy}
            />
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={busy || !body.trim()}>
                <Trans>Comment</Trans>
              </Button>
            </div>
          </form>

          <div data-testid="ticket-comments" className="min-w-0">
            {newestComments.length > 0 ? (
              <div
                data-testid="kanban-ticket-comments"
                className="max-h-[58vh] min-w-0 space-y-2.5 overflow-y-auto pe-1"
              >
                {newestComments.map((row) => (
                  <div
                    key={row.id}
                    data-testid={`kanban-comment-${row.id}`}
                    className="min-w-0 rounded-lg border border-border/50 bg-card/60 px-3 py-2.5 text-body"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2 text-label text-muted-foreground">
                      {inRouter &&
                      row.authorBotId &&
                      bots.some((bot) => bot.id === row.authorBotId) ? (
                        <Link
                          to={`/app/${row.authorBotId}`}
                          className="font-medium hover:text-foreground"
                        >
                          {row.authorName}
                        </Link>
                      ) : (
                        <span className="truncate font-medium text-foreground">
                          {row.authorName}
                        </span>
                      )}
                      <div className="flex shrink-0 items-center gap-1.5">
                        <time dateTime={row.createdAt}>{formatRelativeTime(row.createdAt)}</time>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t`Reply`}
                          data-testid={`kanban-reply-comment-${row.id}`}
                          onClick={() => setReplyToCommentId(row.id)}
                        >
                          <Reply className="size-3" aria-hidden />
                        </Button>
                      </div>
                    </div>
                    <div className="min-w-0 overflow-x-auto text-body-sm leading-relaxed text-foreground [&_pre]:max-w-full [&_pre]:overflow-x-auto">
                      <ChatMarkdown>{row.body}</ChatMarkdown>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-body-sm text-muted-foreground">
                <Trans>No comments yet</Trans>
              </p>
            )}
          </div>
        </aside>
      </div>

      {shownError ? (
        <p role="alert" className="text-body text-destructive">
          {shownError}
        </p>
      ) : null}
    </div>
  );
}

/** Shared create/edit form for a task in both the Kanban modal and the Board page. */
export function TicketEditForm({
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
        <DialogTitle>{ticket ? ticket.ref : t`New ticket`}</DialogTitle>
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
              data-testid="ticket-description-input"
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
