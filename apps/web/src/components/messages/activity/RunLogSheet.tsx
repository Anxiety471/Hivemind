import { Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import {
  Button,
  cn,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@rakazo/ui-web";
import { RotateCcw } from "lucide-react";
import type { CheckpointGraph, CheckpointNode } from "../../../lib/chat/checkpoint-graph";
import {
  formatClockDuration,
  formatModelTitle,
  formatStepDuration,
  stepCategory,
} from "../../../lib/chat/checkpoint-graph";
import { OdometerCost } from "./OdometerCost";
import { StepIconPlate } from "./step-icons";

export interface RunLogSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  modelId?: string | null;
  costUsd?: number | null;
  totalDurationMs?: number;
  graph: CheckpointGraph;
  thinkingLines: readonly string[];
  onRewind?: (stepIndex: number, node: CheckpointNode) => void;
  rewinding?: boolean;
}

export default function RunLogSheet({
  open,
  onOpenChange,
  title,
  modelId,
  costUsd,
  totalDurationMs,
  graph,
  thinkingLines,
  onRewind,
  rewinding = false,
}: RunLogSheetProps) {
  const displayTitle = formatModelTitle(modelId, title);
  const clockLabel = formatClockDuration(
    totalDurationMs && totalDurationMs > 0 ? totalDurationMs : graph.totalDurationMs,
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{displayTitle}</SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-3">
            <span className="font-mono tabular-nums">{clockLabel}</span>
            <OdometerCost costUsd={costUsd} />
            <span className="tabular-nums">
              <Trans>
                {graph.completedCount} / {graph.totalCount} steps
              </Trans>
            </span>
            {graph.totalAttempts > 1 ? (
              <span className="tabular-nums">
                <Trans>{graph.totalAttempts} attempts</Trans>
              </span>
            ) : null}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 px-4 pb-6">
          {thinkingLines.length > 0 ? (
            <section className="space-y-1.5">
              <h3 className="text-caption font-medium tracking-wide text-muted-foreground uppercase">
                <Trans>Reasoning</Trans>
              </h3>
              <div className="rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-label text-muted-foreground">
                {thinkingLines.map((line, index) => (
                  <p key={`thinking-${index}`} className="leading-relaxed">
                    {line}
                  </p>
                ))}
              </div>
            </section>
          ) : null}

          <section className="space-y-2">
            <h3 className="text-caption font-medium tracking-wide text-muted-foreground uppercase">
              <Trans>Execution trace</Trans>
            </h3>
            <div className="space-y-2">
              {graph.nodes.map((node) => {
                const category = stepCategory(node.step.label, node.step.detail);
                const duration = formatStepDuration(node.durationMs);
                const startedOffset =
                  node.startedOffsetMs !== undefined
                    ? `+${formatClockDuration(node.startedOffsetMs)}`
                    : undefined;

                return (
                  <div
                    key={`log-node-${node.index}`}
                    className={cn(
                      "rounded-lg border border-border/70 bg-card p-3",
                      node.isAbandonedBranch && "opacity-60",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <StepIconPlate
                          category={category}
                          size="sm"
                          tone={
                            node.state === "running"
                              ? "working"
                              : node.state === "waiting"
                                ? "waiting"
                                : node.state === "failed"
                                  ? "failed"
                                  : "neutral"
                          }
                        />
                        <span className="text-body-sm font-medium text-foreground">
                          {node.step.label}
                        </span>
                        {node.step.count > 1 ? (
                          <span className="text-caption text-muted-foreground tabular-nums">
                            ×{node.step.count}
                          </span>
                        ) : null}
                        {node.attempt > 1 ? (
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-caption text-muted-foreground tabular-nums">
                            <Trans>Attempt {node.attempt}</Trans>
                          </span>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2 font-mono text-caption text-muted-foreground tabular-nums">
                        {startedOffset ? <span>{startedOffset}</span> : null}
                        {duration ? <span>{duration}</span> : null}
                        {onRewind && node.state !== "running" ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={rewinding}
                            onClick={() => {
                              onRewind(node.index, node);
                              onOpenChange(false);
                            }}
                          >
                            <RotateCcw />
                            <Trans>Rewind</Trans>
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    {node.step.detail ? (
                      <div className="mt-2 rounded border border-border/60 bg-muted/40 px-2 py-1 font-mono text-caption text-foreground break-all">
                        {node.step.detail}
                      </div>
                    ) : null}

                    {node.step.note ? (
                      <div className="mt-2 text-label leading-relaxed text-muted-foreground [&_p]:my-0">
                        <ChatMarkdown>{node.step.note}</ChatMarkdown>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
