import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { splitPeerLabel } from "@rakazo/core";
import { cn } from "@rakazo/ui-web";
import type { LucideIcon } from "lucide-react";
import { CalendarPlus, ChevronRight, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import { getLabs, subscribeLabs } from "../../../lib/bootstrap";

const RoutineTicketModal = lazy(() =>
  import("./routine-ticket-modal").then((module) => ({ default: module.RoutineTicketModal })),
);

type RoutineEventBlock = Extract<MessageBlock, { kind: "routine_event" }>;

const CHANGE_ICON: Record<RoutineEventBlock["change"], LucideIcon> = {
  created: CalendarPlus,
  updated: Pencil,
  enabled: Play,
  disabled: Pause,
  deleted: Trash2,
};

// A ticket reference such as TASK-311; board prefixes are stored in capitals.
const TICKET_REF = /\b([A-Z][A-Z0-9]*-[1-9][0-9]*)\b/;

/**
 * The chat row for a routine that was created, changed, switched on or off, or deleted. The row
 * opens the routine; a ticket reference in its name (TASK-311) opens that ticket on its own.
 */
export function RoutineEventRow({
  block,
  onOpenRoutine,
}: {
  block: RoutineEventBlock;
  /** Opens the routine by name; a deleted one has nothing left to open. */
  onOpenRoutine?: (name: string) => void;
}) {
  const { t } = useLingui();
  const [ticketRef, setTicketRef] = useState<string | null>(null);
  const boardEnabled = useSyncExternalStore(
    subscribeLabs,
    () => getLabs().includes("board"),
    () => false,
  );
  const name = block.name;
  const label = {
    created: t`Created routine "${name}"`,
    updated: t`Updated routine "${name}"`,
    enabled: t`Enabled routine "${name}"`,
    disabled: t`Disabled routine "${name}"`,
    deleted: t`Deleted routine "${name}"`,
  }[block.change];
  const Icon = CHANGE_ICON[block.change];
  const opensRoutine = onOpenRoutine !== undefined && block.change !== "deleted";
  const parts = splitPeerLabel(label, name);
  const ref = boardEnabled ? TICKET_REF.exec(name) : null;
  const refStart = ref ? ref.index : -1;
  const nameParts = ref
    ? {
        before: name.slice(0, refStart),
        ref: ref[1] as string,
        after: name.slice(refStart + (ref[1] as string).length),
      }
    : null;
  const labelText = parts.name ? parts.before : label;

  return (
    <div
      data-testid="routine-event-row"
      data-change={block.change}
      className="flex min-w-0 max-w-full items-center justify-center py-1"
    >
      <div
        className={cn(
          "group relative inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-border/60 bg-card/50 py-1 pr-3 pl-1.5 text-body-sm text-muted-foreground transition-colors",
          opensRoutine && "hover:border-border hover:bg-muted/60 hover:text-foreground",
        )}
      >
        {opensRoutine ? (
          <button
            type="button"
            aria-label={label}
            onClick={() => onOpenRoutine(name)}
            className="absolute inset-0 rounded-full focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          />
        ) : null}
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none grid size-5 shrink-0 place-items-center rounded-full bg-muted text-foreground",
            block.change === "deleted" && "text-destructive",
          )}
        >
          <Icon className="size-3" />
        </span>
        <span dir="auto" className="pointer-events-none min-w-0 truncate">
          {labelText}
          {parts.name ? (
            <>
              {nameParts ? (
                <>
                  <span className="font-medium text-foreground">{nameParts.before}</span>
                  <button
                    type="button"
                    aria-label={nameParts.ref}
                    onClick={() => setTicketRef(nameParts.ref)}
                    className="pointer-events-auto relative z-10 rounded-md bg-muted px-1.5 py-px font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {nameParts.ref}
                  </button>
                  <span className="font-medium text-foreground">{nameParts.after}</span>
                </>
              ) : (
                <span className="font-medium text-foreground">{parts.name}</span>
              )}
              {parts.after}
            </>
          ) : null}
        </span>
        {opensRoutine ? (
          <ChevronRight
            aria-hidden="true"
            className="pointer-events-none -mr-1 size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          />
        ) : null}
      </div>
      {ticketRef ? (
        <Suspense fallback={null}>
          <RoutineTicketModal ticketRef={ticketRef} onClose={() => setTicketRef(null)} />
        </Suspense>
      ) : null}
    </div>
  );
}
