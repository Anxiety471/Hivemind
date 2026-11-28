import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { HelperCardStatus } from "@rakazo/core";
import { helperCardState, helperTextSummary } from "@rakazo/core";
import { Button } from "@rakazo/ui-web/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import {
  ArrowUpRight,
  ChevronDown,
  CircleCheck,
  CircleMinus,
  CircleX,
  LoaderCircle,
} from "lucide-react";
import { useState } from "react";
import type { SubagentBlock } from "../../lib/chat/helper-thread";

/** The card's live state as one quiet pill; a stopped helper is not a failure. */
export function HelperStatusPill({
  status,
  stopped,
}: {
  status: SubagentBlock["status"];
  stopped: boolean;
}) {
  const running = status === "running";
  const failed = status === "failed" && !stopped;
  return (
    <span
      className={`${running ? "motion-safe:animate-[rkPulse_1.2s_ease-in-out_infinite]" : ""} shrink-0 rounded-full px-[11px] py-1 text-body-sm ${
        failed
          ? "bg-destructive/15 text-destructive"
          : running
            ? "bg-warning/15 text-warning"
            : stopped
              ? "bg-muted-foreground/15 text-muted-foreground"
              : "bg-success/15 text-success"
      }`}
    >
      {running ? (
        <Trans>Running</Trans>
      ) : stopped ? (
        <Trans>Stopped</Trans>
      ) : failed ? (
        <Trans>Failed</Trans>
      ) : (
        <Trans>Completed</Trans>
      )}
    </span>
  );
}

/** A helper's status as one icon whose accessible name is the word for it. */
export function HelperStatusIcon({ status }: { status: HelperCardStatus }) {
  const { t } = useLingui();
  const label =
    status === "running"
      ? t`Running`
      : status === "stopped"
        ? t`Stopped`
        : status === "failed"
          ? t`Failed`
          : t`Completed`;
  const icon =
    status === "running" ? (
      <LoaderCircle
        aria-hidden
        className="size-4 text-warning motion-safe:animate-spin"
        strokeWidth={2}
      />
    ) : status === "failed" ? (
      <CircleX aria-hidden className="size-4 text-destructive" strokeWidth={2} />
    ) : status === "stopped" ? (
      <CircleMinus aria-hidden className="size-4 text-muted-foreground" strokeWidth={2} />
    ) : (
      <CircleCheck aria-hidden className="size-4 text-success" strokeWidth={2} />
    );
  return (
    <span role="img" aria-label={label} title={label} data-status={status} className="shrink-0">
      {icon}
    </span>
  );
}

// A running helper's live card and the saved message that replaces it have different ids, so
// its row mounts again when the helper finishes. Remember open cards by agent id across that.
const openHelpers = new Set<string>();

/**
 * A helper's card. Folded, it is one header row (status, name, expand, open) and one muted line
 * of what the helper is doing or was asked, so a long brief or report never fills the chat. Open
 * shows the full brief in a short scrolling region, then the result or progress. Stop, while the
 * helper runs, sits on the summary line, so the header controls never move.
 */
export function SubagentCard({
  block,
  onStop,
  onOpen,
}: {
  block: SubagentBlock;
  /** Stops this background helper; absent for a helper inside a turn. */
  onStop?: () => Promise<unknown>;
  /** Opens this saved helper's own thread; absent for a live card inside a turn. */
  onOpen?: () => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(() => openHelpers.has(block.agentId));
  const [stopping, setStopping] = useState(false);
  const running = block.status === "running";
  const { status, body } = helperCardState(block);
  // While it works, the line says what it is doing now; otherwise what it was asked.
  const summary = helperTextSummary(running && block.progress ? block.progress : block.task);
  // The brief is shown in full only when the one line leaves something out.
  const briefIsLonger = helperTextSummary(block.task) !== block.task.trim();
  // The result or progress shows below the brief unless the one line already says it all.
  const showBody = Boolean(body) && body.trim() !== summary;
  const expandable = briefIsLonger || showBody;
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        if (next) openHelpers.add(block.agentId);
        else openHelpers.delete(block.agentId);
        setOpen(next);
      }}
      data-testid="subagent-card"
      className="w-[420px] max-w-full rounded-2xl border border-border bg-muted px-3.5 py-2.5"
    >
      <div className="flex min-w-0 items-center gap-1">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-0.5 text-start focus-ring">
          <HelperStatusIcon status={status} />
          <span
            className="min-w-0 flex-1 truncate text-body font-medium text-foreground"
            dir="auto"
          >
            {block.name}
          </span>
          <ChevronDown
            data-testid="subagent-chevron"
            aria-hidden
            className={`size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none ${
              open ? "rotate-180" : ""
            } ${expandable ? "" : "invisible"}`}
            strokeWidth={1.8}
          />
        </CollapsibleTrigger>
        {onOpen ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t`Open helper thread`}
            title={t`Open helper thread`}
            className="text-muted-foreground"
            onClick={onOpen}
          >
            <ArrowUpRight aria-hidden />
          </Button>
        ) : (
          <span aria-hidden className="size-6 shrink-0" />
        )}
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-2">
        <span
          data-testid="subagent-summary"
          className="min-w-0 flex-1 truncate text-body-sm text-muted-foreground"
          dir="auto"
          title={summary}
        >
          {summary}
        </span>
        {running && onStop ? (
          <Button
            variant="outline"
            size="xs"
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              // The card settles from the chat's events once the helper stops.
              onStop().catch(() => setStopping(false));
            }}
          >
            <Trans>Stop</Trans>
          </Button>
        ) : null}
      </div>
      {expandable && open ? (
        <CollapsibleContent>
          {briefIsLonger ? (
            <div
              data-testid="subagent-task"
              className="mt-2.5 max-h-60 overflow-y-auto rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-body-sm leading-normal whitespace-pre-wrap text-muted-foreground wrap-anywhere rk-scroll"
              dir="auto"
            >
              {block.task.trim()}
            </div>
          ) : null}
          {showBody ? (
            <div
              data-testid="subagent-body"
              className="mt-2.5 text-body-lg leading-[1.5] text-foreground/75"
            >
              <ChatMarkdown streaming={running}>{body}</ChatMarkdown>
            </div>
          ) : null}
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}
