import "./activity/monitor-animations.css";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useNow } from "@rakazo/chat-ui/hooks";
import type { LoginFieldInput, MessageBlock, ThreadMessage } from "@rakazo/contracts";
import { BotAvatar, Button, cn, DEFAULT_BOT_AVATAR_COLOR, Kbd } from "@rakazo/ui-web";
import { ChevronDown, ExternalLink, Minimize2, Square } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import type { CheckpointNode } from "../../lib/chat/checkpoint-graph";
import {
  buildCheckpointGraph,
  formatClockDuration,
  formatModelTitle,
  stepCategory,
} from "../../lib/chat/checkpoint-graph";
import type { ActivitySummaryKind } from "../../lib/chat/tool-activity-view";
import {
  activityBlocks,
  activityDurationMs,
  activityStepCount,
  activitySummaryParts,
  latestActivity,
} from "../../lib/chat/tool-activity-view";
import { useEventListener } from "../../lib/use-event-listener";
import { isEditableTarget } from "../../pages/shell/shell-shortcuts";
import { Shimmer } from "../ai/primitives";
import { CheckpointTimeline } from "./activity/CheckpointTimeline";
import { CollapsedMonitorPill } from "./activity/CollapsedMonitorPill";
import { OdometerCost } from "./activity/OdometerCost";
import { StepInspectorPopover } from "./activity/StepInspectorPopover";
import { StepCategoryName, StepIconPlate } from "./activity/step-icons";

const RunLogSheet = lazy(() => import("./activity/RunLogSheet"));

type ToolStep = Extract<ThreadMessage["blocks"][number], { kind: "steps" }>["steps"][number];
type StepsBlock = Extract<MessageBlock, { kind: "steps" }>;

/** While a run is live, keep enough steps visible cleanly before scrolling inside the card. */
export const LIVE_TOOL_STEP_WINDOW = 6;

export interface ActivityRunMeta {
  runId?: string;
  botId?: string;
  botName?: string;
  botColor?: string;
  modelId?: string | null;
  modelProvider?: string | null;
  costUsd?: number | null;
  startedAt?: string | null;
  status?: string;
  routineName?: string | null;
  label?: string;
}

export interface PendingApprovalAction {
  block: Extract<MessageBlock, { kind: "ask" }>;
  canAnswer: boolean;
  onAnswer: (text: string, fields?: LoginFieldInput[], remember?: false) => Promise<void>;
}

export interface ActivityPanelProps {
  /** The message's blocks; the panel picks the reasoning and steps out of them. */
  blocks: readonly MessageBlock[];
  live: boolean;
  runMeta?: ActivityRunMeta;
  pendingApproval?: PendingApprovalAction;
  onStop?: () => void;
  onRewind?: (stepIndex: number, step: ToolStep) => Promise<void> | void;
}

function SummaryClause({ kind, count }: { kind: ActivitySummaryKind; count: number }) {
  switch (kind) {
    case "pages":
      return <Plural value={count} one="read a page" other="read # pages" />;
    case "files":
      return <Plural value={count} one="checked a file" other="checked # files" />;
    case "search":
      return <Plural value={count} one="searched the web" other="searched # times" />;
    case "commands":
      return <Plural value={count} one="ran a command" other="ran # commands" />;
    case "writes":
      return <Plural value={count} one="wrote a file" other="wrote # files" />;
    case "edits":
      return <Plural value={count} one="edited a file" other="edited # files" />;
    case "browser":
      return <Plural value={count} one="used the browser" other="used the browser # times" />;
    case "computer":
      return <Plural value={count} one="used the computer" other="used the computer # times" />;
  }
}

function collectActivityDetails(blocks: readonly MessageBlock[]) {
  const activity = activityBlocks(blocks);
  const steps: ToolStep[] = [];
  const thinkingLines: string[] = [];
  let costUsd: number | undefined;
  let attempts: number | undefined;
  let modelId: string | undefined;
  let blockStatus: StepsBlock["status"];

  for (const block of activity) {
    if (block.kind === "thinking") {
      for (const line of block.lines) {
        const trimmed = line.trim();
        if (trimmed) thinkingLines.push(trimmed);
      }
      continue;
    }
    steps.push(...block.steps);
    if (block.costUsd !== undefined) costUsd = block.costUsd;
    if (block.attempts !== undefined) attempts = block.attempts;
    if (block.modelId) modelId = block.modelId;
    if (block.status) blockStatus = block.status;
  }

  return { steps, thinkingLines, costUsd, attempts, modelId, blockStatus };
}

function pickApprovalActions(actions: NonNullable<PendingApprovalAction["block"]["actions"]>) {
  const allow =
    actions.find((action) => /^(allow|approve|confirm|continue|yes|run)$/i.test(action.id)) ??
    actions[0];
  const decline =
    actions.find((action) => /^(deny|decline|reject|cancel|stop|no)$/i.test(action.id)) ??
    actions.find((action) => action.id !== allow?.id);
  return { allow, decline };
}

function resolveMonitorStatus({
  live,
  pendingApproval,
  blockStatus,
  runStatus,
  steps,
}: {
  live: boolean;
  pendingApproval?: PendingApprovalAction;
  blockStatus?: StepsBlock["status"];
  runStatus?: string;
  steps: readonly ToolStep[];
}): "running" | "waiting" | "completed" | "stopped" | "failed" {
  if (pendingApproval) return "waiting";
  if (runStatus === "waiting_input") return "waiting";
  if (live) return "running";
  if (blockStatus === "failed" || runStatus === "failed") return "failed";
  if (blockStatus === "stopped" || runStatus === "cancelled") return "stopped";
  if (steps.some((step) => step.status === "failed" || step.outcomes?.failed)) {
    const allFailed = steps.every((step) => step.status === "failed");
    if (allFailed) return "failed";
  }
  return "completed";
}

function ActivityPanelInner({
  blocks,
  live,
  runMeta,
  pendingApproval,
  onStop,
  onRewind,
}: ActivityPanelProps) {
  const { t } = useLingui();
  const isWaiting = Boolean(pendingApproval) || runMeta?.status === "waiting_input";
  const defaultExpanded = live || isWaiting;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [inspectedStepIndex, setInspectedStepIndex] = useState<number | null>(null);
  const [hoveredBarIndex, setHoveredBarIndex] = useState<number | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [actionInFlight, setActionInFlight] = useState<
    "allow" | "decline" | "stop" | "rewind" | null
  >(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const nowMs = useNow(live ? 1_000 : null);
  const details = collectActivityDetails(blocks);
  const modelId = details.modelId ?? runMeta?.modelId;
  const costUsd = details.costUsd ?? runMeta?.costUsd;
  const fallbackTitle = runMeta?.botName?.trim() || t`Agent`;
  const title = formatModelTitle(modelId, fallbackTitle);

  const parsedStart = runMeta?.startedAt ? Date.parse(runMeta.startedAt) : Number.NaN;
  const runStartedAtMs = Number.isFinite(parsedStart)
    ? parsedStart
    : details.steps.find((step) => step.startedAtMs !== undefined)?.startedAtMs;

  const visualStatus = resolveMonitorStatus({
    live,
    pendingApproval,
    blockStatus: details.blockStatus,
    runStatus: runMeta?.status,
    steps: details.steps,
  });

  const graph = buildCheckpointGraph(details.steps, {
    runStartedAtMs,
    runAttempts: details.attempts,
    runStatus: isWaiting ? "waiting_input" : live ? "running" : runMeta?.status,
    nowMs,
  });

  const recordedDurationMs = activityDurationMs(blocks);
  const elapsedMs =
    !live && recordedDurationMs !== undefined
      ? recordedDurationMs
      : live && runStartedAtMs !== undefined
        ? Math.max(0, nowMs - runStartedAtMs)
        : graph.totalDurationMs;

  const handleApprovalAnswer = async (kind: "allow" | "decline", actionId: string) => {
    if (!pendingApproval?.canAnswer || actionInFlight) return;
    setActionInFlight(kind);
    try {
      await pendingApproval.onAnswer(actionId);
    } finally {
      setActionInFlight(null);
    }
  };

  const handleRewind = async (stepIndex: number, node: CheckpointNode) => {
    if (!onRewind || actionInFlight) return;
    setActionInFlight("rewind");
    try {
      await onRewind(stepIndex, node.step);
      setInspectedStepIndex(null);
    } finally {
      setActionInFlight(null);
    }
  };

  useEventListener(
    typeof window === "undefined" || !pendingApproval?.canAnswer || !expanded ? null : window,
    "keydown",
    (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (inspectedStepIndex !== null || logOpen || actionInFlight !== null) return;
      if (isEditableTarget(document.activeElement)) return;
      const actions = pendingApproval?.block.actions;
      if (!actions || actions.length === 0) return;
      const { allow, decline } = pickApprovalActions(actions);
      if (event.key === "Enter" && allow) {
        const active = document.activeElement;
        if (
          active instanceof HTMLElement &&
          active.tagName === "BUTTON" &&
          !cardRef.current?.contains(active)
        ) {
          return;
        }
        event.preventDefault();
        void handleApprovalAnswer("allow", allow.id);
      } else if (event.key === "Escape" && decline) {
        event.preventDefault();
        void handleApprovalAnswer("decline", decline.id);
      }
    },
  );

  if (!expanded) {
    return (
      <div
        data-testid="tool-activity"
        data-live={live || undefined}
        className="w-full min-w-0"
        dir="auto"
      >
        <div className="w-fit max-w-full" data-testid="activity-trigger-wrap">
          <CollapsedMonitorPill
            graph={graph}
            title={fallbackTitle}
            modelId={modelId}
            costUsd={costUsd}
            totalDurationMs={elapsedMs}
            status={visualStatus}
            onExpand={() => setExpanded(true)}
          />
        </div>
      </div>
    );
  }

  const activeSpineNodes = graph.nodes.filter((node) => !node.isAbandonedBranch);
  const progressNodes = activeSpineNodes.length > 0 ? activeSpineNodes : graph.nodes;
  const activeStepNode =
    graph.nodes.find((node) => node.state === "waiting" || node.state === "running") ??
    activeSpineNodes.at(-1) ??
    graph.nodes.at(-1);
  const summaryParts = activitySummaryParts(blocks);
  const totalCalls = activityStepCount(blocks);
  const latestLine = latestActivity(blocks);
  const bannerLabel = pendingApproval
    ? pendingApproval.block.text
    : activeStepNode
      ? activeStepNode.step.label
      : (details.thinkingLines.at(-1) ??
        runMeta?.label ??
        latestLine ??
        (live ? t`Working…` : t`Completed`));

  const bannerCategory = pendingApproval
    ? stepCategory(pendingApproval.block.text, pendingApproval.block.detail)
    : activeStepNode
      ? stepCategory(activeStepNode.step.label, activeStepNode.step.detail)
      : "tool";

  const bannerClock = formatClockDuration(elapsedMs);
  const inspectedIndex = inspectedStepIndex ?? hoveredBarIndex;
  const inspectedNode = inspectedIndex !== null ? (graph.nodes[inspectedIndex] ?? null) : null;
  const subtitleText =
    runMeta?.botName && runMeta.botName !== title
      ? runMeta.botName
      : (runMeta?.routineName ?? undefined);

  const approvalActions = pendingApproval?.block.actions?.length
    ? pickApprovalActions(pendingApproval.block.actions)
    : null;

  return (
    <div
      ref={cardRef}
      data-testid="tool-activity"
      data-live={live || undefined}
      className="monitor-card-enter w-full max-w-[440px] min-w-0 rounded-2xl border border-border bg-card p-3.5 shadow-sm"
      dir="auto"
    >
      {/* Header: Avatar/Icon + Model & Subtitle + Cost Odometer + Status Pill + Minimize */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {runMeta?.botId ? (
            <BotAvatar
              color={runMeta.botColor ?? DEFAULT_BOT_AVATAR_COLOR}
              identity={runMeta.botId}
              size={28}
              className="shrink-0 rounded-lg"
            />
          ) : (
            <StepIconPlate
              category={bannerCategory}
              tone={
                visualStatus === "running"
                  ? "working"
                  : visualStatus === "waiting"
                    ? "waiting"
                    : "neutral"
              }
            />
          )}
          <div className="min-w-0">
            <div className="truncate text-body-sm font-semibold text-foreground">{title}</div>
            {(subtitleText || graph.totalAttempts > 1) && (
              <div className="flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
                {subtitleText ? <span className="truncate">{subtitleText}</span> : null}
                {graph.totalAttempts > 1 ? (
                  <span className="shrink-0 tabular-nums">
                    <Trans>{graph.totalAttempts} attempts</Trans>
                  </span>
                ) : null}
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <OdometerCost costUsd={costUsd} />
          <StatusPill status={visualStatus} />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-testid="activity-trigger"
            aria-expanded={expanded}
            aria-label={t`Minimize agent monitor`}
            onClick={() => setExpanded(false)}
          >
            <Minimize2 />
          </Button>
        </div>
      </div>

      {/* Active / Needs you / Finished status banner */}
      <div
        className={cn(
          "mt-3 flex items-center justify-between gap-2.5 rounded-xl border px-3 py-2",
          visualStatus === "waiting" && "border-warning/30 bg-warning/12",
          visualStatus === "running" && "border-border/60 bg-muted/60",
          visualStatus === "completed" && "border-border/60 bg-muted/40",
          visualStatus === "stopped" && "border-border/60 bg-muted/40",
          visualStatus === "failed" && "border-destructive/30 bg-destructive/10",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <StepIconPlate
            category={bannerCategory}
            size="sm"
            tone={
              visualStatus === "waiting"
                ? "waiting"
                : visualStatus === "running"
                  ? "working"
                  : visualStatus === "failed"
                    ? "failed"
                    : visualStatus === "completed"
                      ? "done"
                      : "neutral"
            }
          />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {live ? (
              <span className="truncate text-body-sm font-medium text-foreground">
                <Shimmer>{bannerLabel}</Shimmer>
              </span>
            ) : visualStatus === "completed" && summaryParts.length > 0 ? (
              <span className="truncate text-body-sm font-medium text-foreground">
                <Trans>Finished in {bannerClock}</Trans>
                <span className="ml-2 font-normal text-muted-foreground">
                  {summaryParts.map((part, index) => (
                    <span key={part.kind}>
                      {index > 0 ? ", " : ""}
                      <SummaryClause kind={part.kind} count={part.count} />
                    </span>
                  ))}
                </span>
              </span>
            ) : (
              <span className="truncate text-body-sm font-medium text-foreground">
                {bannerLabel}
              </span>
            )}
            {pendingApproval?.block.detail ? (
              <code className="max-w-44 shrink truncate rounded border border-border/70 bg-background/90 px-1.5 py-0.5 font-mono text-caption text-foreground">
                {pendingApproval.block.detail}
              </code>
            ) : null}
          </div>
        </div>
        <span className="shrink-0 font-mono text-label text-muted-foreground tabular-nums">
          {bannerClock}
        </span>
      </div>

      {/* Interactive segmented progress bar + floating Step Inspector */}
      {progressNodes.length > 0 ? (
        <div className="relative mt-3">
          {inspectedNode ? (
            <StepInspectorPopover
              node={inspectedNode}
              rewinding={actionInFlight === "rewind"}
              onClose={() => {
                setInspectedStepIndex(null);
                setHoveredBarIndex(null);
              }}
              onRewind={onRewind ? handleRewind : undefined}
            />
          ) : null}

          <div className="flex items-center gap-1.5">
            <fieldset
              className="m-0 flex h-2 min-w-0 flex-1 items-center gap-1 overflow-hidden rounded-full border-0 bg-muted/70 p-0.5"
              aria-label={t`Step timeline progress`}
            >
              {progressNodes.map((node) => {
                const isSelected = inspectedNode?.index === node.index;
                return (
                  <button
                    key={`seg-${node.index}`}
                    type="button"
                    data-step-inspector-trigger=""
                    aria-label={node.step.label}
                    style={{ flexGrow: node.segmentWeight, flexBasis: 0 }}
                    onMouseEnter={() => {
                      if (inspectedStepIndex === null) setHoveredBarIndex(node.index);
                    }}
                    onMouseLeave={() => {
                      setHoveredBarIndex((current) => (current === node.index ? null : current));
                    }}
                    onClick={() => {
                      setHoveredBarIndex(null);
                      setInspectedStepIndex((current) =>
                        current === node.index ? null : node.index,
                      );
                    }}
                    className={cn(
                      "h-full min-w-2 cursor-pointer rounded-full transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      node.state === "running" && "monitor-segment-shimmer",
                      node.state === "waiting" && "bg-warning",
                      node.state === "failed" && "bg-destructive",
                      node.state === "done" && "bg-foreground/30 hover:bg-foreground/50",
                      node.state === "stopped" && "bg-muted-foreground/30",
                      isSelected && "ring-1 ring-foreground/60",
                    )}
                  />
                );
              })}
            </fieldset>
            {visualStatus === "waiting" ? (
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full bg-warning"
                aria-hidden="true"
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Reasoning snippet */}
      {details.thinkingLines.length > 0 ? (
        <div
          data-testid="thinking-row"
          className="mt-2.5 rounded-lg border border-border/60 bg-muted/40 px-2.5 py-2"
        >
          {details.thinkingLines.length > 1 ? (
            <>
              <button
                type="button"
                data-testid="thinking-trigger"
                aria-expanded={thinkingOpen}
                onClick={() => setThinkingOpen((open) => !open)}
                className="flex w-full items-center justify-between gap-2 text-left text-label text-muted-foreground"
              >
                <span className="truncate">{details.thinkingLines[0]}</span>
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 shrink-0 transition-transform",
                    !thinkingOpen && "-rotate-90",
                  )}
                  aria-hidden="true"
                />
              </button>
              {thinkingOpen ? (
                <div
                  data-testid="thinking-detail"
                  className="mt-1.5 space-y-1 text-caption text-muted-foreground"
                >
                  {details.thinkingLines.slice(1).map((line, index) => (
                    <p key={`think-${index}`} className="leading-relaxed">
                      {line}
                    </p>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <div className="truncate text-label text-muted-foreground">
              {details.thinkingLines[0]}
            </div>
          )}
        </div>
      ) : null}

      {/* Checkpoints timeline + optional SVG git-graph */}
      {graph.nodes.length > 0 ? (
        <div data-testid="tool-rows" className="mt-2.5 max-h-60 overflow-y-auto pr-0.5">
          <CheckpointTimeline
            graph={graph}
            activeStepIndex={inspectedStepIndex ?? undefined}
            isLive={live}
            rewinding={actionInFlight === "rewind"}
            onSelectStep={(node) => {
              setHoveredBarIndex(null);
              setInspectedStepIndex((current) => (current === node.index ? null : node.index));
            }}
            onRewind={onRewind ? handleRewind : undefined}
          />
        </div>
      ) : null}

      {/* Footer controls + step count + Log sheet trigger */}
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-2.5">
        <div className="flex items-center gap-1.5">
          {pendingApproval?.canAnswer && approvalActions ? (
            <>
              {approvalActions.decline ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-keyshortcuts="Escape"
                  disabled={actionInFlight !== null}
                  onClick={() => void handleApprovalAnswer("decline", approvalActions.decline!.id)}
                >
                  <span>{approvalActions.decline.label}</span>
                  <Kbd aria-hidden="true">Esc</Kbd>
                </Button>
              ) : null}
              {approvalActions.allow ? (
                <Button
                  type="button"
                  variant="default"
                  size="xs"
                  aria-keyshortcuts="Enter"
                  disabled={actionInFlight !== null}
                  onClick={() => void handleApprovalAnswer("allow", approvalActions.allow!.id)}
                >
                  <span>{approvalActions.allow.label}</span>
                  <Kbd aria-hidden="true">↵</Kbd>
                </Button>
              ) : null}
            </>
          ) : live && onStop ? (
            <Button
              type="button"
              variant="secondary"
              size="xs"
              disabled={actionInFlight === "stop"}
              onClick={() => {
                setActionInFlight("stop");
                onStop();
              }}
            >
              <Square />
              <Trans>Cancel</Trans>
            </Button>
          ) : (
            <span className="text-caption text-muted-foreground">
              <StepCategoryName category={bannerCategory} />
            </span>
          )}
        </div>

        <div className="flex items-center gap-2.5">
          {graph.totalCount > 0 ? (
            <span className="font-mono text-caption text-muted-foreground tabular-nums">
              {graph.completedCount}/{graph.totalCount}
            </span>
          ) : totalCalls > 0 ? (
            <span className="font-mono text-caption text-muted-foreground tabular-nums">
              {totalCalls}
            </span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setLogOpen(true)}
            aria-label={t`Open execution log`}
          >
            <Trans>Log</Trans>
            <ExternalLink />
          </Button>
        </div>
      </div>

      {logOpen ? (
        <Suspense fallback={null}>
          <RunLogSheet
            open={logOpen}
            onOpenChange={setLogOpen}
            title={fallbackTitle}
            modelId={modelId}
            costUsd={costUsd}
            totalDurationMs={elapsedMs}
            graph={graph}
            thinkingLines={details.thinkingLines}
            onRewind={onRewind ? handleRewind : undefined}
            rewinding={actionInFlight === "rewind"}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

function StatusPill({
  status,
}: {
  status: "running" | "waiting" | "completed" | "stopped" | "failed";
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-caption font-medium",
        status === "running" && "bg-status-working/15 text-status-working",
        status === "waiting" && "bg-warning/15 text-warning",
        status === "completed" && "bg-success/15 text-success",
        status === "stopped" && "bg-muted text-muted-foreground",
        status === "failed" && "bg-destructive/15 text-destructive",
      )}
    >
      <span
        className={cn(
          "inline-block h-1.5 w-1.5 rounded-full",
          status === "running" && "animate-pulse bg-status-working",
          status === "waiting" && "bg-warning",
          status === "completed" && "bg-success",
          status === "stopped" && "bg-muted-foreground",
          status === "failed" && "bg-destructive",
        )}
        aria-hidden="true"
      />
      {status === "running" ? (
        <Trans>Running</Trans>
      ) : status === "waiting" ? (
        <Trans>Needs you</Trans>
      ) : status === "completed" ? (
        <Trans>Finished</Trans>
      ) : status === "stopped" ? (
        <Trans>Stopped</Trans>
      ) : (
        <Trans>Failed</Trans>
      )}
    </span>
  );
}

/**
 * Monitor + Checkpoints card for a bot turn's tool execution, reasoning, approvals, cost, and rewind history.
 * Keyed by active phase so finished turns collapse neatly into a pill while live/approval turns expand.
 */
export function ActivityPanel(props: ActivityPanelProps) {
  const activePhase =
    props.live || props.pendingApproval || props.runMeta?.status === "waiting_input"
      ? "active"
      : "settled";
  return <ActivityPanelInner key={activePhase} {...props} />;
}

/** An activity-only message rendered as its own full-width row rather than a chat bubble. */
export function StandaloneActivity(props: ActivityPanelProps) {
  return (
    <div className="w-full min-w-0" data-testid="tool-activity-line">
      <ActivityPanel {...props} />
    </div>
  );
}

/** A bot message whose only visible blocks are activity: Monitor card row, no bubble. */
export function ActivityOnlyNarration(props: ActivityPanelProps) {
  return <StandaloneActivity {...props} />;
}

/** Initial working monitor shown as soon as a turn starts, before tool steps arrive. */
export function LiveRunMonitorCard({
  runMeta,
  label,
  onStop,
}: {
  runMeta?: ActivityRunMeta;
  label?: string;
  onStop?: () => void;
}) {
  return (
    <div className="w-full min-w-0" data-testid="tool-activity-line">
      <ActivityPanel
        blocks={[]}
        live
        runMeta={{ ...runMeta, label: label ?? runMeta?.label }}
        onStop={onStop}
      />
    </div>
  );
}
