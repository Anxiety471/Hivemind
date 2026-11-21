import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Ticket, TicketStatus } from "@rakazo/contracts";
import { TICKET_STATUSES } from "@rakazo/contracts";
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ContextMenu,
  ContextMenuContent,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuTrigger,
} from "@rakazo/ui-web";
import {
  ChevronDown,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  Columns3,
  LoaderCircle,
  PanelRightClose,
  PanelRightOpen,
  Plus,
} from "lucide-react";
import type { ReactNode } from "react";
import { lazy, Suspense, useState } from "react";
import { IconTooltip } from "../../../components/IconTooltip";
import { formatRelativeTime } from "../../../lib/locale/relative-time";
import { createStoredPreference } from "../../../lib/preferences/stored-preference";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";
import type { KanbanModalTarget } from "../../space/KanbanModal";
import { ticketMentionsMe } from "../../space/ticket-people";
import { useTicketStatusLabels } from "../../space/ticket-status";
import { useBotActiveRun, useBotTickets } from "../../space/use-board-stream";
import { splitRosterName } from "../sidebar/sidebar-roster";

const KanbanModal = lazy(() =>
  import("../../space/KanbanModal").then((module) => ({ default: module.KanbanModal })),
);

const CLOSED_PREVIEW_COUNT = 3;
const PROMPT_TICKET_REF_RE = /\b([A-Za-z][A-Za-z0-9]*-\d+)\b/;

const RAIL_SECTIONS = ["needsYou", "doing", "review", "blocked", "planned", "done"] as const;
type RailSectionKey = (typeof RAIL_SECTIONS)[number];

/** Whether the user collapsed the Tasks rail, kept on this device for every bot. */
const railCollapsedPreference = createStoredPreference<boolean>({
  key: "rakazo.tasksRailMinimized",
  parse: (raw) => raw === "1",
  serialize: (collapsed) => (collapsed ? "1" : null),
});

/** The rail sections the user folded, kept on this device for every bot. */
const collapsedSectionsPreference = createStoredPreference<ReadonlySet<RailSectionKey>>({
  key: "rakazo.tasksRailCollapsed",
  parse: (raw) => {
    try {
      const saved: unknown = raw ? JSON.parse(raw) : [];
      return new Set(RAIL_SECTIONS.filter((key) => Array.isArray(saved) && saved.includes(key)));
    } catch {
      return new Set();
    }
  },
  serialize: (keys) => (keys.size > 0 ? JSON.stringify([...keys]) : null),
});

function newestFirst(a: Ticket, b: Ticket): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

/**
 * Resolves the `TASK-*` reference the bot's active run is working on. Returns null when the active
 * run does not reference a task so the Tasks rail stays quiet during unrelated chat turns.
 */
function resolveActiveTicketRef(
  activeRun: { status: string; trigger: string; promptSnippet?: string } | null,
  tickets: readonly Ticket[],
  doing: readonly Ticket[],
): string | null {
  if (!activeRun) return null;
  const snippet = activeRun.promptSnippet ?? "";
  if (snippet) {
    const upper = snippet.toUpperCase();
    for (const ticket of tickets) {
      if (upper.includes(ticket.ref.toUpperCase())) return ticket.ref;
    }
  }
  if (activeRun.trigger === "tickets") {
    const match = PROMPT_TICKET_REF_RE.exec(snippet);
    if (match?.[1]) return match[1].toUpperCase();
    return doing[0]?.ref ?? null;
  }
  return null;
}

function ticketStatusIcon(status: TicketStatus, working: boolean): ReactNode {
  switch (status) {
    case "todo":
      return <CircleDashed className="size-3.5 text-muted-foreground" aria-hidden />;
    case "doing":
      return working ? (
        <LoaderCircle className="size-3.5 animate-spin text-warning" aria-hidden />
      ) : (
        <CircleDot className="size-3.5 text-warning" aria-hidden />
      );
    case "review":
      return <Circle className="size-3.5 text-warning" aria-hidden />;
    case "blocked":
      return <CircleAlert className="size-3.5 text-destructive" aria-hidden />;
    case "done":
      return <CircleCheck className="size-3.5 text-success" aria-hidden />;
    case "closed":
      return <CircleCheck className="size-3.5 text-muted-foreground" aria-hidden />;
  }
}

/**
 * Persistent right-side task visualization shown alongside a bot conversation when the Kanban
 * board is enabled. Clicking any task or the board icon opens the detailed Kanban modal; a task's
 * right-click menu changes its status in place.
 */
export function ConversationTasksRail({ bot, bots }: { bot: Bot; bots: Bot[] }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [kanbanTarget, setKanbanTarget] = useState<KanbanModalTarget | null>(null);
  const railCollapsed = railCollapsedPreference.use();
  const tickets = useBotTickets(bot.id, !railCollapsed);
  const activeRun = useBotActiveRun(bot.id, !railCollapsed);
  const collapsed = collapsedSectionsPreference.use();
  const moving = useSave({
    save: async (input: { id: string; status: TicketStatus }, rpc) => {
      await rpc.tickets.move(input);
    },
    stale: [queries.tickets.list.key()],
  });

  const needsYou = tickets.filter((item) => ticketMentionsMe(item)).sort(newestFirst);
  const inStatus = (status: TicketStatus) =>
    tickets.filter((item) => item.status === status && !needsYou.includes(item)).sort(newestFirst);
  const doing = inStatus("doing");
  const review = inStatus("review");
  const blocked = inStatus("blocked");
  const planned = inStatus("todo");
  const closed = tickets
    .filter((item) => item.status === "done" || item.status === "closed")
    .sort(newestFirst);

  const doneCount = closed.length;
  const activeCount = tickets.length - doneCount;
  const activeTicketRef = resolveActiveTicketRef(activeRun, tickets, doing);
  const working = Boolean(
    activeTicketRef &&
      activeRun &&
      (activeRun.status === "running" ||
        activeRun.status === "leased" ||
        activeRun.status === "queued" ||
        activeRun.status === "waiting_input" ||
        activeRun.status === "waiting_takeover"),
  );
  const activityLabel = working && activeTicketRef ? t`Working ${activeTicketRef}` : null;

  const botNames = new Map(bots.map((item) => [item.id, splitRosterName(item.name).primary]));
  const waitingOn = (ticket: Ticket) => {
    const names = (ticket.waitingOnBotIds ?? []).flatMap((id) => botNames.get(id) ?? []);
    return names.length > 0 ? t`Waiting on ${names.join(", ")}` : null;
  };

  const section = (key: RailSectionKey, title: string, children: ReactNode, count: number) => (
    <RailSection
      key={key}
      id={key}
      title={title}
      count={count}
      open={!collapsed.has(key)}
      onOpenChange={(open) => {
        const next = new Set(collapsed);
        if (open) next.delete(key);
        else next.add(key);
        collapsedSectionsPreference.set(next);
      }}
    >
      {children}
    </RailSection>
  );
  const rows = (list: Ticket[], options: { working?: boolean; meta?: typeof waitingOn } = {}) => (
    <RailTicketRows
      tickets={list}
      working={options.working ?? false}
      meta={options.meta}
      onSelect={setKanbanTarget}
      onMove={(ticket, status) => moving.run({ id: ticket.id, status })}
    />
  );

  if (railCollapsed) {
    return (
      <aside
        data-testid="conversation-tasks-rail"
        data-collapsed="true"
        aria-label={t`Tasks`}
        className="hidden shrink-0 flex-col items-center border-s border-sidebar-border bg-background px-2 pt-3.5 pb-4 lg:flex"
      >
        <IconTooltip label={t`Show tasks`} side="inline-start">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t`Show tasks`}
            aria-expanded={false}
            data-testid="tasks-rail-toggle"
            onClick={() => railCollapsedPreference.set(false)}
          >
            <PanelRightOpen className="size-4" strokeWidth={1.75} />
          </Button>
        </IconTooltip>
      </aside>
    );
  }

  return (
    <aside
      data-testid="conversation-tasks-rail"
      data-collapsed="false"
      aria-label={t`Tasks`}
      className="hidden w-[276px] shrink-0 flex-col border-s border-sidebar-border bg-background lg:flex xl:w-[308px]"
    >
      <div className="rk-scroll flex h-full min-h-0 flex-col overflow-y-auto px-4 pt-3.5 pb-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-body font-medium text-foreground">
            <Trans>Tasks</Trans>
          </h2>
          <div className="flex items-center gap-0.5">
            <IconTooltip label={t`Open Kanban board`}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t`Open Kanban board`}
                data-testid="tasks-rail-open-kanban"
                onClick={() => setKanbanTarget("board")}
              >
                <Columns3 className="size-4" strokeWidth={1.75} />
              </Button>
            </IconTooltip>
            <IconTooltip label={t`New task`}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t`New task`}
                data-testid="tasks-rail-add-task"
                onClick={() => setKanbanTarget("new")}
              >
                <Plus className="size-4" strokeWidth={1.75} />
              </Button>
            </IconTooltip>
            <IconTooltip label={t`Hide tasks`}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t`Hide tasks`}
                aria-expanded={true}
                data-testid="tasks-rail-toggle"
                onClick={() => railCollapsedPreference.set(true)}
              >
                <PanelRightClose className="size-4" strokeWidth={1.75} />
              </Button>
            </IconTooltip>
          </div>
        </div>

        {activityLabel ? (
          <div
            data-testid="tasks-rail-activity"
            className="mb-3 flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-label text-foreground"
          >
            <LoaderCircle className="size-3.5 shrink-0 animate-spin text-warning" aria-hidden />
            <span className="truncate">{activityLabel}</span>
          </div>
        ) : null}

        {moving.error ? (
          <p role="alert" className="mb-2 text-label text-destructive">
            {errorText(moving.error)}
          </p>
        ) : null}

        {tickets.length > 0 ? (
          <>
            <div
              data-testid="tasks-rail-summary"
              className="mb-3 flex items-center gap-3 text-label text-muted-foreground"
            >
              <span>
                <Trans>{activeCount} open</Trans>
              </span>
              <span>
                <Trans>{doneCount} done</Trans>
              </span>
            </div>

            {section("needsYou", t`Needs you`, rows(needsYou), needsYou.length)}
            {section("doing", t`Doing`, rows(doing, { working }), doing.length)}
            {section("review", t`Review`, rows(review), review.length)}
            {section("blocked", t`Blocked`, rows(blocked, { meta: waitingOn }), blocked.length)}
            {section("planned", t`Planned`, rows(planned), planned.length)}
            {section(
              "done",
              t`Done`,
              <RailClosedRows tickets={closed} render={(shown) => rows(shown)} />,
              closed.length,
            )}
          </>
        ) : (
          <div className="flex flex-col items-start gap-2 pt-1 text-body-sm text-muted-foreground">
            <p>
              <Trans>No tasks yet</Trans>
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ms-2"
              data-testid="tasks-rail-empty-board"
              onClick={() => setKanbanTarget("board")}
            >
              <Columns3 className="size-3.5" aria-hidden />
              <Trans>Open board</Trans>
            </Button>
          </div>
        )}
      </div>

      {kanbanTarget ? (
        <Suspense fallback={null}>
          <KanbanModal
            key={
              kanbanTarget === "board" || kanbanTarget === "new"
                ? kanbanTarget
                : `ticket:${kanbanTarget.id}`
            }
            open
            target={kanbanTarget}
            botId={bot.id}
            botName={bot.name}
            bots={bots}
            onClose={() => setKanbanTarget(null)}
          />
        </Suspense>
      ) : null}
    </aside>
  );
}

function RailSection({
  id,
  title,
  count,
  open,
  onOpenChange,
  children,
}: {
  id: RailSectionKey;
  title: string;
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      data-testid={`tasks-rail-section-${id}`}
      className="mb-2.5"
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-label text-muted-foreground hover:text-foreground">
        <ChevronDown
          className="size-3.5 -rotate-90 transition-transform group-data-[panel-open]:rotate-0"
          aria-hidden
        />
        <span>{title}</span>
        <span className="ms-auto text-faint-foreground">{count}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

function RailTicketRows({
  tickets,
  working,
  meta,
  onSelect,
  onMove,
}: {
  tickets: Ticket[];
  working: boolean;
  /** Replaces the ref and time under a ticket's title when it returns text. */
  meta?: (ticket: Ticket) => string | null;
  onSelect: (ticket: Ticket) => void;
  onMove: (ticket: Ticket, status: TicketStatus) => void;
}) {
  const { t } = useLingui();
  const statuses = useTicketStatusLabels();
  return (
    <ul className="mt-0.5 flex flex-col gap-0.5">
      {tickets.map((ticket) => {
        const note = meta?.(ticket) ?? null;
        return (
          <li key={ticket.id}>
            <ContextMenu>
              <ContextMenuTrigger
                render={<button type="button" />}
                data-testid={`tasks-rail-ticket-${ticket.id}`}
                onClick={() => onSelect(ticket)}
                className="flex w-full flex-col gap-0.5 rounded-md px-1.5 py-1.5 text-start transition-colors hover:bg-accent"
              >
                <div className="flex w-full items-start gap-2">
                  <span className="flex h-lh shrink-0 items-center text-body-sm">
                    {ticketStatusIcon(ticket.status, working)}
                  </span>
                  <span
                    className="line-clamp-2 min-w-0 flex-1 text-body-sm text-foreground"
                    dir="auto"
                  >
                    {ticket.title}
                  </span>
                </div>
                <div className="flex w-full items-center justify-between gap-2 ps-5.5 text-label text-muted-foreground">
                  {note ? (
                    <span className="truncate" dir="auto">
                      {note}
                    </span>
                  ) : (
                    <>
                      <span>{ticket.ref}</span>
                      <span className="text-faint-foreground">
                        {formatRelativeTime(ticket.updatedAt)}
                      </span>
                    </>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent aria-label={t`Status of ${ticket.ref}`}>
                <ContextMenuRadioGroup
                  value={ticket.status}
                  onValueChange={(next: TicketStatus) => {
                    if (next !== ticket.status) onMove(ticket, next);
                  }}
                >
                  {TICKET_STATUSES.map((status) => (
                    <ContextMenuRadioItem key={status} value={status}>
                      {statuses[status]}
                    </ContextMenuRadioItem>
                  ))}
                </ContextMenuRadioGroup>
              </ContextMenuContent>
            </ContextMenu>
          </li>
        );
      })}
    </ul>
  );
}

function RailClosedRows({
  tickets,
  render,
}: {
  tickets: Ticket[];
  render: (shown: Ticket[]) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? tickets : tickets.slice(0, CLOSED_PREVIEW_COUNT);
  const hidden = tickets.length - shown.length;
  return (
    <>
      {render(shown)}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-0.5 rounded-md px-1.5 py-1 text-label text-muted-foreground hover:text-foreground"
        >
          <Trans>Show {hidden} more</Trans>
        </button>
      ) : null}
    </>
  );
}
