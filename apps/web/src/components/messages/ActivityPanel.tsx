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
import type { ActivitySummaryKind } from "../../lib/chat/tool-activity-view";
import {
  activityBlocks,
  activityDurationMs,
  activityStepCount,
  activitySummaryParts,
  latestActivity,
} from "../../lib/chat/tool-activity-view";

type ToolStep = Extract<ThreadMessage["blocks"][number], { kind: "steps" }>["steps"][number];

/** While a run is live, only the most recent tool rows are listed so a long run does not push the chat down. */
export const LIVE_TOOL_STEP_WINDOW = 6;

type ActivityRow =
  | { kind: "thinking"; key: string; lines: string[]; durationMs: number }
  | { kind: "step"; key: string; step: ToolStep; current: boolean };

/** One flat list of what the bot did, in the order it did it: each reasoning segment, then each tool call. */
function activityRows(blocks: readonly MessageBlock[], live: boolean): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const block of activityBlocks(blocks)) {
    if (block.kind === "thinking") {
      const lines = block.lines.filter((line) => line.trim().length > 0);
      if (lines.length > 0) {
        rows.push({
          kind: "thinking",
          key: `thinking:${rows.length}`,
          lines,
          durationMs: block.durationMs,
        });
      }
      continue;
    }
    for (const step of block.steps) {
      rows.push({ kind: "step", key: `step:${rows.length}`, step, current: false });
    }
  }
  if (!live) return rows;
  const lastStepIndex = rows.findLastIndex((row) => row.kind === "step");
  const lastStep = rows[lastStepIndex];
  if (lastStep?.kind === "step") rows[lastStepIndex] = { ...lastStep, current: true };
  return rows;
}

const URL_TEXT_RE = /(https?:\/\/[^\s]+)/g;

/** A row's one-line detail, with any URL underlined the way a fetched page reads. */
function RowText({ text }: { text: string }) {
  return (
    <>
      {text.split(URL_TEXT_RE).map((part, index) =>
        index % 2 === 1 ? (
          <span key={index} className="underline underline-offset-2 break-all">
            {part}
          </span>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * One line for a reasoning segment: its first line, with the full lines on demand. The
 * duration is kept in the detail, so the row itself stays one quiet sentence.
 */
function ThinkingRow({
  lines,
  durationMs,
  newest,
}: {
  lines: string[];
  durationMs: number;
  /** The segment the live run is thinking right now; it starts open and folds once settled. */
  newest: boolean;
}) {
  const summary = lines[0]!;
  const duration = formatCompactDuration(durationMs);
  const expandable = lines.length > 1;
  const text = (
    <span
      className="min-w-0 flex-1 truncate text-start text-body-sm text-muted-foreground"
      title={lines.join("\n")}
    >
      {summary}
    </span>
  );
  if (!expandable) {
    return (
      <div data-testid="thinking-row" className="flex min-w-0 items-center gap-1.5 px-3 py-2">
        {text}
      </div>
    );
  }
  return (
    <Collapsible
      defaultOpen={newest}
      data-testid="thinking-row"
      className="group/row"
      data-live={newest || undefined}
    >
      <CollapsibleTrigger
        data-testid="thinking-trigger"
        className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 px-3 py-2 text-start hover:bg-accent/40 focus-ring"
      >
        {text}
        <ChevronRight
          aria-hidden
          size={13}
          strokeWidth={1.8}
          className="shrink-0 text-muted-foreground/70 transition-transform duration-150 group-data-open/row:rotate-90 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent hiddenUntilFound>
        <div data-testid="thinking-detail" className="px-3 pb-3 text-body-sm text-muted-foreground">
          {duration ? (
            <div className="mb-1 text-label text-muted-foreground/70">
              <Trans>Thought for {duration}</Trans>
            </div>
          ) : null}
          <div className="space-y-1.5">
            {lines.map((line, index) => (
              <p key={index}>{line}</p>
            ))}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * One line for a tool call: its muted action, then the brighter thing it touched — the note
 * the bot wrote before the call. A call with more to say folds open to the full note.
 */
function StepRow({ step, current }: { step: ToolStep; current: boolean }) {
  const note = step.note?.trim();
  const object = note
    ?.split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim();
  const content = (
    <>
      <span className="shrink-0 text-body-sm text-muted-foreground" title={step.label}>
        {step.label}
        {step.count > 1 ? ` ×${step.count}` : ""}
      </span>
      {object ? (
        <span className="min-w-0 flex-1 truncate text-body-sm text-foreground/85" title={note}>
          <RowText text={object} />
        </span>
      ) : null}
      {current ? (
        <span
          aria-hidden
          className="shrink-0 text-label text-muted-foreground motion-safe:animate-[rkPulse_1.2s_ease-in-out_infinite]"
        >
          ◷
        </span>
      ) : null}
    </>
  );
  if (!note) {
    return (
      <div data-testid="activity-row" className="flex min-w-0 items-center gap-1.5 px-3 py-2">
        {content}
      </div>
    );
  }
  return (
    <Collapsible data-testid="activity-row" className="group/row">
      <CollapsibleTrigger
        data-testid="activity-row-trigger"
        className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 px-3 py-2 text-start hover:bg-accent/40 focus-ring"
      >
        {content}
        <ChevronRight
          aria-hidden
          size={13}
          strokeWidth={1.8}
          className="shrink-0 text-muted-foreground/70 transition-transform duration-150 group-data-open/row:rotate-90 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent hiddenUntilFound>
        <div data-testid="tool-step-note" className="px-3 pb-3 text-body-sm text-muted-foreground">
          <ChatMarkdown>{note}</ChatMarkdown>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** One counted action, said in words; the trigger capitalizes the first clause. */
function SummaryClause({ kind, count }: { kind: ActivitySummaryKind; count: number }) {
  switch (kind) {
    case "pages":
      return <Plural value={count} one="read a page" other="read # pages" />;
    case "files":
      return <Plural value={count} one="read a file" other="read # files" />;
    case "search":
      return <Plural value={count} one="searched the web" other="searched the web # times" />;
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

/** One collapsible block for what a bot did before or while answering: the reasoning it
 * streamed and the tools it ran, as one flat list in the order they happened. Its trigger
 * summarizes the finished run's actions ("read 2 pages, searched the web"), or names the
 * newest thing while it runs; it starts open while the run is live and folds when it ends.
 * The keyed default keeps manual toggles until the run changes phase.
 */
export function ActivityPanel({
  blocks,
  live,
}: {
  /** The message's blocks; the panel picks the reasoning and steps out of them. */
  blocks: readonly MessageBlock[];
  live: boolean;
}) {
  const rows = activityRows(blocks, live);
  const summary = live ? [] : activitySummaryParts(blocks);
  const toolCount = activityStepCount(blocks);
  const duration = live ? null : formatCompactDuration(activityDurationMs(blocks));
  const latest = latestActivity(blocks);
  // While live, the newest reasoning row stays open so a streaming thought is readable;
  // a finished run folds every row back to its one-line summary.
  const lastThinkingKey = rows.findLast((row) => row.kind === "thinking")?.key;
  const stepIndexes = rows.flatMap((row, index) => (row.kind === "step" ? [index] : []));
  const hiddenSteps = live ? Math.max(0, stepIndexes.length - LIVE_TOOL_STEP_WINDOW) : 0;
  const hidden = new Set(stepIndexes.slice(0, hiddenSteps));
  return (
    <Collapsible
      key={live ? "working" : "actions"}
      defaultOpen={live}
      data-testid="tool-activity"
      data-live={live || undefined}
      className="group w-full min-w-0"
      dir="auto"
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
        <span className="min-w-0 truncate first-letter:uppercase" title={live ? latest : undefined}>
          {summary.length > 0
            ? summary.map((part, index) => (
                <Fragment key={part.kind}>
                  {index > 0 ? ", " : null}
                  <SummaryClause kind={part.kind} count={part.count} />
                </Fragment>
              ))
            : (latest ?? (live ? <Trans>Working…</Trans> : <Trans>Done</Trans>))}
        </span>
        {toolCount > 0 && (live || summary.length === 0) ? (
          <span className="shrink-0 text-muted-foreground">
            {" · "}
            <Plural value={toolCount} one="# tool" other="# tools" />
          </span>
        ) : null}
        {duration ? <span className="shrink-0 text-muted-foreground"> · {duration}</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent hiddenUntilFound>
        <div
          data-testid="tool-rows"
          className="mt-2 divide-y divide-border/40 overflow-hidden rounded-xl border border-border/50 bg-card/55"
        >
          {hiddenSteps > 0 ? (
            <div
              data-testid="tool-rows-hidden"
              className="px-3 py-1.5 text-label text-muted-foreground/70"
            >
              <Plural value={hiddenSteps} one="+# earlier step" other="+# earlier steps" />
            </div>
          ) : null}
          {rows.map((row, index) => {
            if (hidden.has(index)) return null;
            if (row.kind === "step") {
              return <StepRow key={row.key} step={row.step} current={row.current} />;
            }
            // A row stops being the live one when a newer thought starts; the new key folds it
            // back to its summary instead of leaving every streamed segment open.
            const newest = live && row.key === lastThinkingKey;
            return (
              <ThinkingRow
                key={`${row.key}:${newest ? "live" : "settled"}`}
                lines={row.lines}
                durationMs={row.durationMs}
                newest={newest}
              />
            );
          })}
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
    <div className="w-full min-w-0" data-testid="tool-activity-line">
      <ActivityPanel blocks={blocks} live={live} />
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
