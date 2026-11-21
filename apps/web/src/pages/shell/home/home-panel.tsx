import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Routine, Ticket, TicketStatus } from "@rakazo/contracts";
import {
  BotAvatar,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web";
import {
  ChevronDown,
  Circle,
  CircleCheck,
  CircleDashed,
  Columns3,
  LoaderCircle,
  Plus,
  Settings,
  X,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useState } from "react";
import { IconTooltip } from "../../../components/IconTooltip";
import { compactRosterStatusLabel } from "../../../lib/chat/roster-status";
import { formatRelativeTime } from "../../../lib/locale/relative-time";
import type { RoutineList } from "../../routines/RoutineList";
import { routineTriggerSummary } from "../../routines/RoutineList";
import type { KanbanModalTarget } from "../../space/KanbanModal";
import { useBotTickets } from "../../space/use-board-stream";
import { homeGroups } from "./home-groups";

/** Closed work shows this many rows before "Show more". */
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
 * What the bot is doing and has coming up: its tickets by stage, then its automations. Tickets
 * come from the Board lab, so a space without it shows the automations alone.
 */
export function HomePanel({
  bot,
  boardEnabled,
  routineList,
  onOpenKanban,
  onOpenSettings,
  onClose,
}: {
  bot: Bot;
  boardEnabled: boolean;
  routineList: Omit<ComponentProps<typeof RoutineList>, "preview">;
  onOpenKanban?: (target: KanbanModalTarget) => void;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const tickets = useBotTickets(bot.id, boardEnabled);
  const groups = homeGroups(tickets);
  const status = compactRosterStatusLabel(bot.status);
  const totalTickets = tickets.length;
  const activeCount = groups.inProgress.length + groups.planned.length;
  const doneCount = groups.closed.length;
  return (
    <div data-testid="home-panel" className="flex flex-col gap-1">
      <div className="mb-3 flex items-center gap-3">
        <BotAvatar
          avatarSet={bot.avatarSet}
          color={bot.color}
          identity={bot.id}
          size={36}
          status={bot.status}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body-lg font-medium text-foreground" dir="auto">
            {bot.name}
          </div>
          {status ? (
            <div className="truncate text-body-sm text-muted-foreground">{status}</div>
          ) : null}
        </div>
        {boardEnabled && onOpenKanban ? (
          <IconTooltip label={t`Open Kanban board`}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t`Open Kanban board`}
              data-testid="home-open-kanban"
              onClick={() => onOpenKanban("board")}
            >
              <Columns3 className="size-4.5" strokeWidth={1.75} />
            </Button>
          </IconTooltip>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          aria-label={t`Settings`}
          data-testid="home-panel-settings"
          onClick={onOpenSettings}
        >
          <Settings className="size-4.5" strokeWidth={1.75} />
        </Button>
        <Button variant="ghost" size="icon" aria-label={t`Close panel`} onClick={onClose}>
          <X className="size-4.5" strokeWidth={1.75} />
        </Button>
      </div>
      {boardEnabled ? (
        <>
          {totalTickets > 0 ? (
            <TaskProgressBar
              inProgress={groups.inProgress.length}
              planned={groups.planned.length}
              done={doneCount}
              total={totalTickets}
              activeCount={activeCount}
              onAdd={onOpenKanban ? () => onOpenKanban("new") : undefined}
            />
          ) : null}
          <Section title={t`In progress`} count={groups.inProgress.length}>
            <TicketRows tickets={groups.inProgress} onSelect={onOpenKanban} />
          </Section>
          <Section title={t`Planned`} count={groups.planned.length}>
            <TicketRows tickets={groups.planned} onSelect={onOpenKanban} />
          </Section>
          <Section title={t`Closed`} count={groups.closed.length}>
            <ClosedRows tickets={groups.closed} onSelect={onOpenKanban} />
          </Section>
        </>
      ) : null}
      <Section title={t`Automations`} count={routineList.routines.length}>
        <AutomationRows routineList={routineList} />
      </Section>
      {/* With nothing to list, the one thing to do is offered, so the panel is not left blank. */}
      {routineList.routines.length === 0 && routineList.loaded && tickets.length === 0 ? (
        <div className="flex flex-col gap-1">
          {boardEnabled && onOpenKanban ? (
            <Button
              variant="ghost"
              data-testid="home-new-task"
              className="justify-start"
              onClick={() => onOpenKanban("new")}
            >
              <Plus aria-hidden />
              <Trans>New task</Trans>
            </Button>
          ) : null}
          <Button
            variant="ghost"
            data-testid="home-new-routine"
            className="justify-start"
            onClick={routineList.onCreate}
          >
            <Plus aria-hidden />
            <Trans>New routine</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function TaskProgressBar({
  inProgress,
  planned,
  done,
  total,
  activeCount,
  onAdd,
}: {
  inProgress: number;
  planned: number;
  done: number;
  total: number;
  activeCount: number;
  onAdd?: () => void;
}) {
  const { t } = useLingui();
  const donePct = (done / total) * 100;
  const inProgressPct = (inProgress / total) * 100;
  const plannedPct = (planned / total) * 100;
  return (
    <div data-testid="home-task-progress" className="mb-3 flex flex-col gap-2 px-1">
      <div className="flex items-center justify-between gap-2 text-body-sm text-muted-foreground">
        <div className="flex items-center gap-3">
          <span>
            <Trans>{activeCount} open</Trans>
          </span>
          <span>
            <Trans>{done} done</Trans>
          </span>
        </div>
        {onAdd ? (
          <IconTooltip label={t`New task`}>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t`New task`}
              data-testid="home-add-task"
              onClick={onAdd}
            >
              <Plus className="size-3.5" strokeWidth={1.75} />
            </Button>
          </IconTooltip>
        ) : null}
      </div>
      <div
        role="progressbar"
        aria-label={t`Task progress`}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        {donePct > 0 ? <div className="bg-success" style={{ width: `${donePct}%` }} /> : null}
        {inProgressPct > 0 ? (
          <div className="bg-warning" style={{ width: `${inProgressPct}%` }} />
        ) : null}
        {plannedPct > 0 ? (
          <div className="bg-muted-foreground/30" style={{ width: `${plannedPct}%` }} />
        ) : null}
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  // A stage with nothing in it takes no room.
  if (count === 0) return null;
  return (
    <Collapsible defaultOpen className="mb-2">
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md px-1 py-1.5 text-body-sm text-muted-foreground hover:text-foreground">
        <ChevronDown
          className="size-3.5 -rotate-90 transition-transform group-data-[panel-open]:rotate-0"
          aria-hidden
        />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

function TicketRows({
  tickets,
  onSelect,
}: {
  tickets: Ticket[];
  onSelect?: (ticket: Ticket) => void;
}) {
  return (
    <ul>
      {tickets.map((ticket) => (
        <TicketRow key={ticket.id} ticket={ticket} onSelect={onSelect} />
      ))}
    </ul>
  );
}

function TicketRow({ ticket, onSelect }: { ticket: Ticket; onSelect?: (ticket: Ticket) => void }) {
  return (
    <li>
      <button
        type="button"
        data-testid="home-ticket"
        onClick={() => onSelect?.(ticket)}
        className="flex w-full items-center gap-2.5 rounded-md px-1 py-1.5 text-start text-body hover:bg-accent"
      >
        <span className="shrink-0">{statusIcon[ticket.status]}</span>
        <span className="shrink-0 text-muted-foreground">{ticket.ref}</span>
        <span className="min-w-0 flex-1 truncate text-foreground" dir="auto">
          {ticket.title}
        </span>
        <span className="shrink-0 text-body-sm text-faint-foreground">
          {formatRelativeTime(ticket.updatedAt)}
        </span>
      </button>
    </li>
  );
}

function ClosedRows({
  tickets,
  onSelect,
}: {
  tickets: Ticket[];
  onSelect?: (ticket: Ticket) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? tickets : tickets.slice(0, CLOSED_PREVIEW_COUNT);
  const hidden = tickets.length - shown.length;
  return (
    <>
      <TicketRows tickets={shown} onSelect={onSelect} />
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="rounded-md px-1 py-1.5 text-body-sm text-muted-foreground hover:text-foreground"
        >
          <Trans>Show {hidden} more</Trans>
        </button>
      ) : null}
    </>
  );
}

function AutomationRows({
  routineList,
}: {
  routineList: Omit<ComponentProps<typeof RoutineList>, "preview">;
}) {
  return (
    <ul>
      {routineList.routines.map((routine) => (
        <AutomationRow
          key={routine.id}
          routine={routine}
          onOpen={() => routineList.onEdit(routine)}
        />
      ))}
    </ul>
  );
}

function AutomationRow({ routine, onOpen }: { routine: Routine; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        data-testid="home-automation"
        onClick={onOpen}
        className="flex w-full items-center gap-2.5 rounded-md px-1 py-1.5 text-start text-body hover:bg-accent"
      >
        <span className="min-w-0 flex-1 truncate text-foreground" dir="auto">
          {routine.name}
        </span>
        <span className="shrink-0 truncate text-body-sm text-muted-foreground">
          {routineTriggerSummary(routine)}
        </span>
      </button>
    </li>
  );
}
