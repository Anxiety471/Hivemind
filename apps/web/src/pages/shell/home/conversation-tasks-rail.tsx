import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Ticket, TicketStatus } from "@rakazo/contracts";
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@rakazo/ui-web";
import {
  ChevronDown,
  Circle,
  CircleCheck,
  CircleDashed,
  Columns3,
  LoaderCircle,
  Plus,
} from "lucide-react";
import type { ReactNode } from "react";
import { lazy, Suspense, useState } from "react";
import { IconTooltip } from "../../../components/IconTooltip";
import { formatRelativeTime } from "../../../lib/locale/relative-time";
import type { KanbanModalTarget } from "../../space/KanbanModal";
import { useBotTickets } from "../../space/use-board-stream";
import { homeGroups } from "./home-groups";

const KanbanModal = lazy(() =>
  import("../../space/KanbanModal").then((module) => ({ default: module.KanbanModal })),
);

const CLOSED_PREVIEW_COUNT = 3;

const statusIcon: Record<TicketStatus, ReactNode> = {
  todo: <CircleDashed className="size-3.5 text-muted-foreground" aria-hidden />,
  doing: <LoaderCircle className="size-3.5 text-warning" aria-hidden />,
  review: <Circle className="size-3.5 text-warning" aria-hidden />,
  blocked: <Circle className="size-3.5 text-destructive" aria-hidden />,
  done: <CircleCheck className="size-3.5 text-success" aria-hidden />,
  closed: <CircleCheck className="size-3.5 text-muted-foreground" aria-hidden />,
};

/**
 * Persistent right-side task visualization shown alongside a bot conversation when the Kanban
 * board is enabled. Clicking any task or the board icon opens the detailed Kanban modal.
 */
export function ConversationTasksRail({ bot, bots }: { bot: Bot; bots: Bot[] }) {
  const { t } = useLingui();
  const [kanbanTarget, setKanbanTarget] = useState<KanbanModalTarget | null>(null);
  const tickets = useBotTickets(bot.id, true);
  const groups = homeGroups(tickets);
  const total = tickets.length;
  const activeCount = groups.inProgress.length + groups.planned.length;
  const doneCount = groups.closed.length;

  return (
    <aside
      data-testid="conversation-tasks-rail"
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
          </div>
        </div>

        {total > 0 ? (
          <>
            <div data-testid="tasks-rail-progress" className="mb-3.5 flex flex-col gap-1.5">
              <div className="flex items-center gap-3 text-label text-muted-foreground">
                <span>
                  <Trans>{activeCount} open</Trans>
                </span>
                <span>
                  <Trans>{doneCount} done</Trans>
                </span>
              </div>
              <div
                role="progressbar"
                aria-label={t`Task progress`}
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={doneCount}
                className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
              >
                {doneCount > 0 ? (
                  <div className="bg-success" style={{ width: `${(doneCount / total) * 100}%` }} />
                ) : null}
                {groups.inProgress.length > 0 ? (
                  <div
                    className="bg-warning"
                    style={{ width: `${(groups.inProgress.length / total) * 100}%` }}
                  />
                ) : null}
                {groups.planned.length > 0 ? (
                  <div
                    className="bg-muted-foreground/30"
                    style={{ width: `${(groups.planned.length / total) * 100}%` }}
                  />
                ) : null}
              </div>
            </div>

            <RailSection title={t`In progress`} count={groups.inProgress.length}>
              <RailTicketRows tickets={groups.inProgress} onSelect={setKanbanTarget} />
            </RailSection>
            <RailSection title={t`Planned`} count={groups.planned.length}>
              <RailTicketRows tickets={groups.planned} onSelect={setKanbanTarget} />
            </RailSection>
            <RailSection title={t`Done`} count={groups.closed.length}>
              <RailClosedRows tickets={groups.closed} onSelect={setKanbanTarget} />
            </RailSection>
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
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <Collapsible defaultOpen className="mb-2.5">
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
  onSelect,
}: {
  tickets: Ticket[];
  onSelect: (ticket: Ticket) => void;
}) {
  return (
    <ul className="mt-0.5 flex flex-col gap-0.5">
      {tickets.map((ticket) => (
        <li key={ticket.id}>
          <button
            type="button"
            data-testid={`tasks-rail-ticket-${ticket.id}`}
            onClick={() => onSelect(ticket)}
            className="flex w-full flex-col gap-0.5 rounded-md px-1.5 py-1.5 text-start transition-colors hover:bg-accent"
          >
            <div className="flex w-full items-center gap-2">
              <span className="shrink-0">{statusIcon[ticket.status]}</span>
              <span className="min-w-0 flex-1 truncate text-body-sm text-foreground" dir="auto">
                {ticket.title}
              </span>
            </div>
            <div className="flex w-full items-center justify-between gap-2 ps-5.5 text-label text-muted-foreground">
              <span>{ticket.ref}</span>
              <span className="text-faint-foreground">{formatRelativeTime(ticket.updatedAt)}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function RailClosedRows({
  tickets,
  onSelect,
}: {
  tickets: Ticket[];
  onSelect: (ticket: Ticket) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? tickets : tickets.slice(0, CLOSED_PREVIEW_COUNT);
  const hidden = tickets.length - shown.length;
  return (
    <>
      <RailTicketRows tickets={shown} onSelect={onSelect} />
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
