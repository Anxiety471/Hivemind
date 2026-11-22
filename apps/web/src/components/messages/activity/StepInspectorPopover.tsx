import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { Button, cn } from "@rakazo/ui-web";
import { RotateCcw, X } from "lucide-react";
import type { CheckpointNode } from "../../../lib/chat/checkpoint-graph";
import {
  formatClockDuration,
  formatStepDuration,
  stepCategory,
} from "../../../lib/chat/checkpoint-graph";
import { stepDisplayInfo } from "../../../lib/chat/tool-activity-view";
import { useEventListener } from "../../../lib/use-event-listener";
import { StepCategoryName, StepIconPlate } from "./step-icons";

export interface StepInspectorPopoverProps {
  node: CheckpointNode;
  onClose: () => void;
  onRewind?: (stepIndex: number, node: CheckpointNode) => void;
  rewinding?: boolean;
}

export function StepInspectorPopover({
  node,
  onClose,
  onRewind,
  rewinding = false,
}: StepInspectorPopoverProps) {
  const { t } = useLingui();

  useEventListener(typeof window === "undefined" ? null : window, "keydown", (event) => {
    if (event.key === "Escape") onClose();
  });

  const info = stepDisplayInfo(node.step);
  const category = stepCategory(node.step.label, node.step.detail);
  const startedLabel =
    node.startedOffsetMs !== undefined ? `+${formatClockDuration(node.startedOffsetMs)}` : "—";
  const tookLabel = node.durationMs !== undefined ? formatStepDuration(node.durationMs) : "—";

  const stateTone =
    node.state === "running"
      ? "working"
      : node.state === "waiting"
        ? "waiting"
        : node.state === "failed"
          ? "failed"
          : node.state === "done"
            ? "done"
            : "neutral";

  return (
    <div
      role="dialog"
      aria-label={t`Step inspector: ${node.step.label}`}
      className="monitor-card-enter w-full min-w-0 rounded-xl border border-border/80 bg-muted/35 p-3.5 text-foreground"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <StepIconPlate category={category} tone={stateTone} />
          <div className="min-w-0">
            <div className="truncate text-body-sm font-medium text-foreground">
              {node.step.label}
              {node.step.count > 1 ? (
                <span className="ml-1.5 text-label text-muted-foreground tabular-nums">
                  ×{node.step.count}
                </span>
              ) : null}
            </div>
            <div className="text-caption text-muted-foreground">
              <StepCategoryName category={category} />
            </div>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t`Close step inspector`}
          onClick={onClose}
        >
          <X />
        </Button>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2 rounded-lg border border-border/60 bg-muted/50 px-2.5 py-2">
        <MetricCell label={<Trans>Started</Trans>} value={startedLabel} mono />
        <MetricCell label={<Trans>Took</Trans>} value={tookLabel} mono />
        <MetricCell label={<Trans>Share</Trans>} value={`${node.sharePercent}%`} mono />
        <div className="min-w-0">
          <div className="text-caption text-muted-foreground">
            <Trans>State</Trans>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-label font-medium text-foreground">
            <span
              className={cn(
                "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
                node.state === "running" && "bg-status-working",
                node.state === "waiting" && "bg-warning",
                node.state === "failed" && "bg-destructive",
                node.state === "done" && "bg-success",
                node.state === "stopped" && "bg-muted-foreground/60",
              )}
              aria-hidden="true"
            />
            <span className="truncate">
              <StateText state={node.state} />
            </span>
          </div>
        </div>
      </div>

      {info.note ? (
        <div className="mt-2.5 max-h-36 overflow-y-auto text-label leading-relaxed text-muted-foreground [&_p]:my-0">
          <ChatMarkdown>{info.note}</ChatMarkdown>
        </div>
      ) : null}

      {info.detail ? (
        <div className="mt-2.5 max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-background/80 px-2.5 py-1.5 font-mono text-caption text-foreground">
          {info.detail}
        </div>
      ) : null}

      {onRewind && node.state !== "running" ? (
        <div className="mt-3 flex items-center justify-end border-t border-border/60 pt-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={rewinding}
            onClick={() => onRewind(node.index, node)}
          >
            <RotateCcw />
            <Trans>Rewind to here</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function MetricCell({
  label,
  value,
  mono = false,
}: {
  label: React.ReactNode;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-caption text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-0.5 truncate text-label font-medium text-foreground tabular-nums",
          mono && "font-mono",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function StateText({ state }: { state: CheckpointNode["state"] }) {
  switch (state) {
    case "running":
      return <Trans>Running</Trans>;
    case "waiting":
      return <Trans>Needs you</Trans>;
    case "failed":
      return <Trans>Failed</Trans>;
    case "stopped":
      return <Trans>Stopped</Trans>;
    case "done":
      return <Trans>Done</Trans>;
  }
}
