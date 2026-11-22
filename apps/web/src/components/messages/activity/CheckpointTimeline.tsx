import { Trans, useLingui } from "@lingui/react/macro";
import { cn } from "@rakazo/ui-web";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import type { CheckpointGraph, CheckpointNode } from "../../../lib/chat/checkpoint-graph";
import { formatStepDuration, stepCategory } from "../../../lib/chat/checkpoint-graph";
import { StepIconPlate } from "./step-icons";

const ROW_HEIGHT_PX = 34;
const LANE_SPACING_PX = 16;
const RAIL_BASE_X = 10;

export interface CheckpointTimelineProps {
  graph: CheckpointGraph;
  activeStepIndex?: number;
  isLive?: boolean;
  onSelectStep: (node: CheckpointNode) => void;
  onHoverStep?: (node: CheckpointNode | null) => void;
  onRewind?: (stepIndex: number, node: CheckpointNode) => void;
  rewinding?: boolean;
}

export function CheckpointTimeline({
  graph,
  activeStepIndex,
  isLive = false,
  onSelectStep,
  onHoverStep,
  onRewind,
  rewinding = false,
}: CheckpointTimelineProps) {
  const { t } = useLingui();
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const { nodes, maxLane, hasBranching } = graph;
  if (nodes.length === 0) return null;

  const railWidth = (maxLane + 1) * LANE_SPACING_PX + 8;
  const totalHeight = nodes.length * ROW_HEIGHT_PX;
  const xFor = (lane: number) => RAIL_BASE_X + lane * LANE_SPACING_PX;
  const yFor = (index: number) => index * ROW_HEIGHT_PX + ROW_HEIGHT_PX / 2;

  const activeSpineNodes = nodes.filter((node) => node.lane === 0);
  const lastActiveNode = activeSpineNodes.at(-1);

  const branchLanes = [...new Set(nodes.filter((node) => node.lane > 0).map((node) => node.lane))];

  const handleEnter = (node: CheckpointNode) => {
    setHoveredIndex(node.index);
    onHoverStep?.(node);
  };
  const handleLeave = (node: CheckpointNode) => {
    setHoveredIndex((current) => (current === node.index ? null : current));
    onHoverStep?.(null);
  };

  return (
    <div className="relative">
      {hasBranching ? (
        <svg
          aria-hidden="true"
          width={railWidth}
          height={totalHeight}
          viewBox={`0 0 ${railWidth} ${totalHeight}`}
          className="pointer-events-none absolute top-0 left-0 select-none"
        >
          {/* Active lane = 0 spine */}
          {activeSpineNodes.map((node, pos) => {
            if (pos === 0) return null;
            const prev = activeSpineNodes[pos - 1]!;
            const x = xFor(0);
            return (
              <line
                key={`spine-${prev.index}-${node.index}`}
                x1={x}
                y1={yFor(prev.index)}
                x2={x}
                y2={yFor(node.index)}
                stroke="var(--status-working)"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            );
          })}

          {/* Abandoned fork branches into lane 1+ */}
          {branchLanes.map((lane) => {
            const laneNodes = nodes.filter((node) => node.lane === lane);
            if (laneNodes.length === 0) return null;
            const first = laneNodes[0]!;
            const last = laneNodes.at(-1)!;
            const laneX = xFor(lane);
            const firstY = yFor(first.index);
            const lastY = yFor(last.index);
            const forkParent =
              first.forkFromIndex !== undefined ? nodes[first.forkFromIndex] : undefined;
            const parentX = xFor(forkParent?.lane ?? 0);
            const parentY = yFor(forkParent?.index ?? Math.max(0, first.index - 1));
            const midY = (parentY + firstY) / 2;

            return (
              <g key={`branch-${lane}`} opacity={0.55}>
                <path
                  d={`M ${parentX} ${parentY} C ${parentX} ${midY}, ${laneX} ${midY}, ${laneX} ${firstY}`}
                  fill="none"
                  stroke="var(--muted-foreground)"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
                {last.index > first.index ? (
                  <line
                    x1={laneX}
                    y1={firstY}
                    x2={laneX}
                    y2={lastY}
                    stroke="var(--muted-foreground)"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                ) : null}
                <line
                  x1={laneX}
                  y1={lastY}
                  x2={laneX}
                  y2={Math.min(totalHeight - 2, lastY + 9)}
                  stroke="var(--muted-foreground)"
                  strokeWidth="1.4"
                  strokeDasharray="2 2"
                  strokeLinecap="round"
                />
              </g>
            );
          })}

          {/* Graph node circles */}
          {nodes.map((node) => {
            const cx = xFor(node.lane);
            const cy = yFor(node.index);
            const isCurrent =
              node.state === "running" ||
              (isLive && lastActiveNode?.index === node.index && node.lane === 0);

            if (node.isAbandonedBranch || node.state === "stopped") {
              return (
                <circle
                  key={`node-${node.index}`}
                  cx={cx}
                  cy={cy}
                  r={3}
                  fill="var(--card)"
                  stroke="var(--muted-foreground)"
                  strokeWidth="1.4"
                  opacity={0.7}
                />
              );
            }
            if (node.state === "failed") {
              return (
                <circle
                  key={`node-${node.index}`}
                  cx={cx}
                  cy={cy}
                  r={3.5}
                  fill="var(--destructive)"
                />
              );
            }
            if (node.state === "waiting") {
              return (
                <g key={`node-${node.index}`}>
                  <circle cx={cx} cy={cy} r={6.5} fill="var(--warning)" opacity={0.22} />
                  <circle cx={cx} cy={cy} r={3.5} fill="var(--warning)" />
                </g>
              );
            }
            if (isCurrent) {
              return (
                <g key={`node-${node.index}`}>
                  <circle cx={cx} cy={cy} r={6.5} fill="var(--status-working)" opacity={0.2} />
                  <circle cx={cx} cy={cy} r={3.75} fill="var(--status-working)" />
                </g>
              );
            }
            return (
              <circle
                key={`node-${node.index}`}
                cx={cx}
                cy={cy}
                r={3.5}
                fill="var(--card)"
                stroke="var(--status-working)"
                strokeWidth="1.75"
              />
            );
          })}
        </svg>
      ) : null}

      <div className="space-y-0.5">
        {nodes.map((node) => {
          const category = stepCategory(node.step.label, node.step.detail);
          const durationLabel = formatStepDuration(node.durationMs);
          const isInspected = activeStepIndex === node.index;
          const isDimmedByHover = hoveredIndex !== null && hoveredIndex !== node.index;
          const canShowRewind = Boolean(onRewind) && node.state !== "running";

          return (
            <div
              key={`row-${node.index}`}
              className={cn(
                "group/step relative flex min-h-[34px] items-center justify-between gap-2 rounded-lg pr-1.5 transition-opacity duration-150",
                isInspected && "bg-accent/70",
                !isInspected && "hover:bg-accent/45",
                node.isAbandonedBranch && "opacity-55",
                isDimmedByHover && !node.isAbandonedBranch && "opacity-45",
              )}
              style={hasBranching ? { paddingLeft: `${railWidth + 4}px` } : { paddingLeft: "4px" }}
            >
              <button
                type="button"
                data-step-inspector-trigger=""
                className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left focus-visible:outline-none"
                onMouseEnter={() => handleEnter(node)}
                onMouseLeave={() => handleLeave(node)}
                onFocus={() => handleEnter(node)}
                onBlur={() => handleLeave(node)}
                onClick={() => onSelectStep(node)}
              >
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
                <span className="truncate text-body-sm text-foreground">
                  {node.step.label}
                  {node.step.count > 1 ? (
                    <span className="ml-1 text-label text-muted-foreground tabular-nums">
                      ×{node.step.count}
                    </span>
                  ) : null}
                </span>
                {node.attemptBadge !== undefined ? (
                  <span className="inline-flex shrink-0 items-center rounded-full bg-status-working/12 px-1.5 py-0.5 text-caption font-medium text-status-working tabular-nums">
                    <Trans>Attempt {node.attemptBadge}</Trans>
                  </span>
                ) : null}
              </button>

              <div className="flex shrink-0 items-center gap-1.5">
                {canShowRewind ? (
                  <button
                    type="button"
                    disabled={rewinding}
                    aria-label={t`Rewind to ${node.step.label}`}
                    onMouseEnter={() => handleEnter(node)}
                    onMouseLeave={() => handleLeave(node)}
                    onFocus={() => handleEnter(node)}
                    onBlur={() => handleLeave(node)}
                    onClick={(event) => {
                      event.stopPropagation();
                      onRewind?.(node.index, node);
                    }}
                    className={cn(
                      "hidden items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-caption font-medium text-foreground shadow-2xs transition-colors hover:bg-accent focus-visible:inline-flex focus-visible:outline-none group-hover/step:inline-flex group-focus-within/step:inline-flex",
                    )}
                  >
                    <RotateCcw className="h-3 w-3" aria-hidden="true" />
                    <Trans>Rewind</Trans>
                  </button>
                ) : null}

                <span
                  className={cn(
                    "font-mono text-label tabular-nums text-muted-foreground",
                    canShowRewind && "group-hover/step:hidden group-focus-within/step:hidden",
                  )}
                >
                  {node.state === "stopped" ? (
                    <span className="font-sans text-caption text-muted-foreground">
                      <Trans>Stopped</Trans>
                    </span>
                  ) : durationLabel ? (
                    durationLabel
                  ) : node.state === "running" ? (
                    <span className="text-caption text-status-working">
                      <Trans>Live</Trans>
                    </span>
                  ) : null}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
