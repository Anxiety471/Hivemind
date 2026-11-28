import { Trans } from "@lingui/react/macro";
import { cn } from "@rakazo/ui-web";
import { AlertCircle, CheckCircle2, Clock, Code2, Terminal, X } from "lucide-react";
import { formatClockDuration } from "../../../lib/chat/checkpoint-graph";
import type { JobBlock } from "./job-card-helpers";

function stateLabel(state: JobBlock["state"]) {
  if (state === "starting") return <Trans>Starting</Trans>;
  if (state === "working") return <Trans>Working</Trans>;
  if (state === "finished") return <Trans>Finished</Trans>;
  if (state === "needs_input") return <Trans>Needs input</Trans>;
  if (state === "timed_out") return <Trans>Timed out</Trans>;
  return <Trans>Exited</Trans>;
}

/** The pill's tone, kept beside its label so every state reads the same wherever it is drawn. */
function stateTone(state: JobBlock["state"]): string {
  if (state === "finished") return "bg-success/15 text-success";
  if (state === "needs_input") return "bg-warning/15 text-warning";
  if (state === "starting" || state === "working")
    return "bg-status-working/15 text-status-working";
  return "bg-muted text-muted-foreground";
}

/** The thin bar at the top of a card: its whole state, readable at a glance. */
export function accentTone(state: JobBlock["state"]): string {
  if (state === "finished") return "bg-success/80";
  if (state === "needs_input") return "bg-warning";
  if (state === "starting" || state === "working")
    return "bg-status-working motion-safe:animate-pulse";
  return "bg-muted-foreground/30";
}

/** The plate behind the card's icon and the icon it holds: a terminal, or code for coding work. */
function iconTone(state: JobBlock["state"]): string {
  if (state === "finished") return "bg-success/12 text-success";
  if (state === "needs_input") return "bg-warning/12 text-warning";
  if (state === "starting" || state === "working")
    return "bg-status-working/12 text-status-working";
  return "bg-muted text-muted-foreground";
}

export function StatusPill({
  block,
  live,
  durationMs,
}: {
  block: JobBlock;
  live: boolean;
  durationMs: number | undefined;
}) {
  return (
    <span
      data-testid="job-status"
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-caption font-medium tabular-nums",
        stateTone(block.state),
      )}
    >
      {live ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-status-working motion-safe:animate-[rkPulse_1.2s_ease-in-out_infinite]"
          aria-hidden
        />
      ) : block.state === "finished" ? (
        <CheckCircle2 className="size-3 shrink-0" aria-hidden />
      ) : block.state === "needs_input" ? (
        <AlertCircle className="size-3 shrink-0" aria-hidden />
      ) : block.state === "timed_out" ? (
        <Clock className="size-3 shrink-0" aria-hidden />
      ) : (
        <X className="size-3 shrink-0" aria-hidden />
      )}
      <span className="whitespace-nowrap">{stateLabel(block.state)}</span>
      {durationMs === undefined ? null : (
        <span className="hidden font-mono opacity-80 @[360px]:inline">
          {formatClockDuration(durationMs)}
        </span>
      )}
    </span>
  );
}

/** The plate and icon at a card's head, so the card and its inspector read alike. */
export function JobIcon({ block }: { block: JobBlock }) {
  const Icon = block.files?.length || block.steps?.length ? Code2 : Terminal;
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg",
        iconTone(block.state),
      )}
      aria-hidden
    >
      <Icon className="size-4" strokeWidth={1.9} />
    </span>
  );
}
