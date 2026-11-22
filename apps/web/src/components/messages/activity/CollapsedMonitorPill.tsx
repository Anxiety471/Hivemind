import { Trans, useLingui } from "@lingui/react/macro";
import { cn, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@rakazo/ui-web";
import { Maximize2 } from "lucide-react";
import type { CheckpointGraph } from "../../../lib/chat/checkpoint-graph";
import {
  formatClockDuration,
  formatModelTitle,
  formatStepDuration,
  stepCategory,
} from "../../../lib/chat/checkpoint-graph";
import { OdometerCost } from "./OdometerCost";
import { StepCategoryIcon } from "./step-icons";

export interface CollapsedMonitorPillProps {
  graph: CheckpointGraph;
  title: string;
  modelId?: string | null;
  costUsd?: number | null;
  totalDurationMs?: number;
  status: "running" | "waiting" | "completed" | "stopped" | "failed";
  onExpand: () => void;
}

export function CollapsedMonitorPill({
  graph,
  title,
  modelId,
  costUsd,
  totalDurationMs,
  status,
  onExpand,
}: CollapsedMonitorPillProps) {
  const { t } = useLingui();
  const displayTitle = formatModelTitle(modelId, title);
  const chipNodes = graph.nodes.slice(-5);
  const overflowCount = Math.max(0, graph.nodes.length - chipNodes.length);
  const clockLabel = formatClockDuration(
    totalDurationMs && totalDurationMs > 0 ? totalDurationMs : graph.totalDurationMs,
  );

  return (
    <TooltipProvider>
      <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-card px-2.5 py-1 shadow-2xs transition-colors hover:border-border/90 hover:bg-accent/35">
        <button
          type="button"
          data-testid="activity-trigger"
          onClick={onExpand}
          aria-expanded={false}
          aria-label={t`Expand agent monitor for ${displayTitle}`}
          className="inline-flex min-w-0 items-center gap-2 text-left focus-visible:outline-none"
        >
          <span
            className={cn(
              "inline-block h-2 w-2 shrink-0 rounded-full",
              status === "running" && "animate-pulse bg-status-working",
              status === "waiting" && "bg-warning",
              status === "failed" && "bg-destructive",
              status === "stopped" && "bg-muted-foreground",
              status === "completed" && "bg-success",
            )}
            aria-hidden="true"
          />
          <span className="max-w-64 truncate text-label font-medium text-foreground">
            {displayTitle}
          </span>
        </button>

        {chipNodes.length > 0 ? (
          <div className="flex items-center gap-1">
            {chipNodes.map((node) => {
              const category = stepCategory(node.step.label, node.step.detail);
              const duration = formatStepDuration(node.durationMs);
              return (
                <Tooltip key={`chip-${node.index}`}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={onExpand}
                        aria-label={node.step.label}
                        className={cn(
                          "inline-flex h-5 w-5 items-center justify-center rounded-md border border-border/80 bg-background text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground",
                          node.state === "running" &&
                            "border-status-working/40 bg-status-working/10 text-status-working",
                          node.state === "waiting" &&
                            "border-warning/40 bg-warning/15 text-warning",
                          node.state === "failed" &&
                            "border-destructive/35 bg-destructive/10 text-destructive",
                          node.isAbandonedBranch && "opacity-50",
                        )}
                      >
                        <StepCategoryIcon category={category} className="h-3 w-3" />
                      </button>
                    }
                  />
                  <TooltipContent>
                    <span>{node.step.label}</span>
                    {duration ? (
                      <span className="font-mono text-background/75 tabular-nums">{duration}</span>
                    ) : null}
                  </TooltipContent>
                </Tooltip>
              );
            })}
            {overflowCount > 0 ? (
              <span className="px-1 text-caption text-muted-foreground tabular-nums">
                +{overflowCount}
              </span>
            ) : null}
          </div>
        ) : null}

        <button
          type="button"
          onClick={onExpand}
          aria-label={t`Open agent monitor`}
          className="inline-flex shrink-0 items-center gap-2 focus-visible:outline-none"
        >
          <OdometerCost costUsd={costUsd} className="text-caption" />
          <span className="font-mono text-caption text-muted-foreground tabular-nums">
            {clockLabel}
          </span>
          {graph.totalAttempts > 1 ? (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-caption text-muted-foreground tabular-nums">
              <Trans>{graph.totalAttempts} tries</Trans>
            </span>
          ) : null}
          <Maximize2 className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
        </button>
      </div>
    </TooltipProvider>
  );
}
