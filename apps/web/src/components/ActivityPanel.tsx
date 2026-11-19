import { Plural, Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import { formatCompactDuration } from "@rakazo/core";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { ChevronRight } from "lucide-react";
import { Fragment } from "react";
import {
  activityBlocks,
  activityDurationMs,
  activityStepCount,
  latestActivity,
} from "../lib/tool-activity-view";
import { ThinkingPanel } from "./ThinkingPanel";

type ToolStep = Extract<ThreadMessage["blocks"][number], { kind: "steps" }>["steps"][number];

/** While a run is live, only the most recent steps are listed so a long run does not push the chat down. */
export const LIVE_TOOL_STEP_WINDOW = 6;

/**
 * The monochrome rows one panel lists its tool calls as. Every call is the same muted line;
 * only the call still running pulses, and its full label is kept in the title when truncated.
 */
export function ToolSteps({
  steps,
  currentIndex,
  limit,
}: {
  steps: readonly ToolStep[];
  currentIndex?: number;
  /** Show only the last `limit` steps, with a count of the earlier ones above them. */
  limit?: number;
}) {
  const hidden = limit !== undefined && steps.length > limit ? steps.length - limit : 0;
  const shown = hidden > 0 ? steps.slice(hidden) : steps;
  return (
    <div className="space-y-0.5" data-testid="tool-rows">
      {hidden > 0 ? (
        <div className="text-label leading-5 text-muted-foreground" data-testid="tool-rows-hidden">
          <Plural value={hidden} one="+# earlier step" other="+# earlier steps" />
        </div>
      ) : null}
      {shown.map((step, offset) => {
        const index = hidden + offset;
        const isCurrent = index === currentIndex;
        return (
          <Fragment key={index}>
            {step.note ? (
              <div className="py-1 text-body-sm text-foreground/75" data-testid="tool-step-note">
                <ChatMarkdown>{step.note}</ChatMarkdown>
              </div>
            ) : null}
            <div className="flex min-w-0 items-center gap-2 leading-5">
              <span
                className={`text-label text-muted-foreground ${
                  isCurrent
                    ? "motion-safe:animate-[rkPulse_1.2s_ease-in-out_infinite]"
                    : "text-muted-foreground/60"
                }`}
              >
                {isCurrent ? "◷" : "✓"}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-body-sm text-muted-foreground"
                title={step.label}
              >
                {step.label}
                {step.count > 1 ? ` ×${step.count}` : ""}
              </span>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * One collapsible panel for what a bot did before or while answering: the reasoning it
 * streamed and the tools it ran. Its trigger is the newest of those, so a live run reads
 * as a sentence; it starts open while the run is live and folds when the run ends. The
 * keyed default keeps manual toggles until the run changes phase.
 */
export function ActivityPanel({
  blocks,
  live,
}: {
  /** The message's blocks; the panel picks the reasoning and steps out of them. */
  blocks: readonly MessageBlock[];
  live: boolean;
}) {
  const activity = activityBlocks(blocks);
  const steps = activity.flatMap((block) => (block.kind === "steps" ? block.steps : []));
  const toolCount = activityStepCount(blocks);
  const duration = live ? null : formatCompactDuration(activityDurationMs(blocks));
  const latest = latestActivity(blocks);
  return (
    <Collapsible
      key={live ? "working" : "actions"}
      defaultOpen={live}
      data-testid="tool-activity"
      data-live={live || undefined}
      className="group"
    >
      <CollapsibleTrigger
        data-testid="activity-trigger"
        className="flex min-h-6 w-fit max-w-full cursor-pointer list-none items-center gap-1.5 rounded-md text-body-sm font-medium text-foreground/80 hover:text-foreground focus-ring"
      >
        <ChevronRight
          aria-hidden
          size={14}
          strokeWidth={1.8}
          className="shrink-0 transition-transform duration-150 group-data-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="min-w-0 truncate" title={latest}>
          {latest ?? (live ? <Trans>Working…</Trans> : <Trans>Done</Trans>)}
        </span>
        {toolCount > 0 ? (
          <span className="shrink-0 text-muted-foreground">
            {" · "}
            <Plural value={toolCount} one="# tool" other="# tools" />
          </span>
        ) : null}
        {duration ? <span className="shrink-0 text-muted-foreground"> · {duration}</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent hiddenUntilFound>
        <div className="mt-2 space-y-2 rounded-xl border border-border/50 bg-card/55 p-3">
          {activity.map((block, i) =>
            block.kind === "thinking" ? (
              <div key={i} data-testid="thinking-row">
                <ThinkingPanel durationMs={block.durationMs} lines={block.lines} />
              </div>
            ) : null,
          )}
          {steps.length > 0 ? (
            <ToolSteps
              steps={steps}
              currentIndex={live ? steps.length - 1 : undefined}
              limit={live ? LIVE_TOOL_STEP_WINDOW : undefined}
            />
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * An activity-only message: a plain line between messages, not a chat bubble.
 */
export function StandaloneActivity({
  blocks,
  live,
}: {
  blocks: readonly MessageBlock[];
  live: boolean;
}) {
  return (
    <div className="flex justify-start" dir="ltr" data-testid="tool-activity-line">
      <div className="max-w-full min-w-0 ps-1">
        <ActivityPanel blocks={blocks} live={live} />
      </div>
    </div>
  );
}

/** A bot message whose only visible blocks are activity: one slim line, no bubble. */
export function ActivityOnlyNarration({
  blocks,
  live,
}: {
  blocks: readonly MessageBlock[];
  live: boolean;
}) {
  return <StandaloneActivity blocks={blocks} live={live} />;
}
