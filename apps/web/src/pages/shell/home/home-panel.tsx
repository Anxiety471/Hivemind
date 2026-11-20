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
  LoaderCircle,
  Settings,
  X,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useState } from "react";
import { compactRosterStatusLabel } from "../../../lib/chat/roster-status";
import { formatRelativeTime } from "../../../lib/locale/relative-time";
import type { RoutineList } from "../../routines/RoutineList";
import { routineTriggerSummary } from "../../routines/RoutineList";
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
  onOpenSettings,
  onClose,
}: {
  bot: Bot;
  boardEnabled: boolean;
  routineList: Omit<ComponentProps<typeof RoutineList>, "preview">;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const tickets = useBotTickets(bot.id, boardEnabled);
  const groups = homeGroups(tickets);
  const status = compactRosterStatusLabel(bot.status);
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
          <Section title={t`In progress`} count={groups.inProgress.length}>
            <TicketRows tickets={groups.inProgress} />
          </Section>
          <Section title={t`Planned`} count={groups.planned.length}>
            <TicketRows tickets={groups.planned} />
          </Section>
          <Section title={t`Closed`} count={groups.closed.length}>
            <ClosedRows tickets={groups.closed} />
          </Section>
        </>
      ) : null}
      <Section title={t`Automations`} count={routineList.routines.length}>
        <AutomationRows routineList={routineList} />
      </Section>
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

function TicketRows({ tickets }: { tickets: Ticket[] }) {
  return (
    <ul>
      {tickets.map((ticket) => (
        <TicketRow key={ticket.id} ticket={ticket} />
      ))}
    </ul>
  );
}

function TicketRow({ ticket }: { ticket: Ticket }) {
  return (
    <li
      data-testid="home-ticket"
      className="flex items-center gap-2.5 rounded-md px-1 py-1.5 text-body"
    >
      <span className="shrink-0">{statusIcon[ticket.status]}</span>
      <span className="shrink-0 text-muted-foreground">{ticket.ref}</span>
      <span className="min-w-0 flex-1 truncate text-foreground" dir="auto">
        {ticket.title}
      </span>
      <span className="shrink-0 text-body-sm text-faint-foreground">
        {formatRelativeTime(ticket.updatedAt)}
      </span>
    </li>
  );
}

function ClosedRows({ tickets }: { tickets: Ticket[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? tickets : tickets.slice(0, CLOSED_PREVIEW_COUNT);
  const hidden = tickets.length - shown.length;
  return (
    <>
      <TicketRows tickets={shown} />
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
