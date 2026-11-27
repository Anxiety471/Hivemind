import type { JobCardStep } from "@rakazo/contracts";
import { cn } from "@rakazo/ui-web";
import {
  Check,
  ChevronDown,
  FilePenLine,
  Loader2,
  MessageSquare,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { useState } from "react";
import { formatStepDuration } from "../../../lib/chat/checkpoint-graph";

function stepIcon(kind: JobCardStep["kind"]) {
  if (kind === "command") return Terminal;
  if (kind === "edit") return FilePenLine;
  if (kind === "note") return MessageSquare;
  return Wrench;
}

function StepStatus({ status }: { status: JobCardStep["status"] }) {
  if (status === "ok") return <Check className="size-3 shrink-0 text-success" aria-hidden />;
  if (status === "error") return <X className="size-3 shrink-0 text-destructive" aria-hidden />;
  if (status === "running")
    return <Loader2 className="size-3 shrink-0 animate-spin text-status-working" aria-hidden />;
  return <span className="size-1 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden />;
}

function StepRow({ step }: { step: JobCardStep }) {
  const [open, setOpen] = useState(false);
  const Icon = stepIcon(step.kind);
  const detail = step.detail?.trim();
  const duration = formatStepDuration(step.durationMs);
  return (
    <li data-testid="job-step" className="min-w-0 rounded-md px-2 py-1.5 hover:bg-muted/40">
      <button
        type="button"
        disabled={!detail}
        aria-expanded={detail ? open : undefined}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full min-w-0 items-center gap-2 rounded text-start focus-ring disabled:cursor-default"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-body-sm text-foreground/90" title={step.name}>
          {step.name}
        </span>
        {duration ? (
          <span className="shrink-0 font-mono text-caption text-muted-foreground tabular-nums">
            {duration}
          </span>
        ) : null}
        <StepStatus status={step.status} />
        {detail ? (
          <ChevronDown
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
              open && "rotate-180",
            )}
            aria-hidden
          />
        ) : null}
      </button>
      {open && detail ? (
        // off-scale: command detail is dense monospace code, sized like the diff view.
        <code className="mt-1 block max-h-32 overflow-y-auto rounded bg-muted/50 px-2 py-1 font-mono text-[11px] leading-[1.45] break-words whitespace-pre-wrap text-muted-foreground">
          {detail}
        </code>
      ) : null}
    </li>
  );
}

export function ActivityList({ steps }: { steps: readonly JobCardStep[] }) {
  return (
    <ol className="flex min-w-0 flex-col rounded-xl border border-border/45 bg-background/25 p-1">
      {steps.map((step, index) => (
        <StepRow key={`${step.name}-${index}`} step={step} />
      ))}
    </ol>
  );
}
