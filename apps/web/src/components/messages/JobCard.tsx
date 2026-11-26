import { Trans, useLingui } from "@lingui/react/macro";
import { useNow } from "@rakazo/chat-ui/hooks";
import type { MessageBlock } from "@rakazo/contracts";
import { httpsUrl } from "@rakazo/core";
import { Badge } from "@rakazo/ui-web/components/ui/badge";
import { Card, CardContent } from "@rakazo/ui-web/components/ui/card";
import { cn } from "@rakazo/ui-web/lib/utils";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { formatClockDuration } from "../../lib/chat/checkpoint-graph";

/** Longest preview of a job's reply before it needs opening; shorter ones need no control. */
const PREVIEW_CHARS = 220;

type JobBlock = Extract<MessageBlock, { kind: "job" }>;

/** A job card is live while the job runs: its elapsed time counts up from when it started. */
function liveJob(block: JobBlock): boolean {
  return block.state === "starting" || block.state === "working";
}

function stateTone(state: JobBlock["state"]): string {
  if (state === "finished") return "text-success";
  if (state === "exited" || state === "timed_out") return "text-muted-foreground";
  return "text-warning";
}

/**
 * A job a tool started somewhere else, drawn from that tool's own result: what it is, who is
 * doing it, how it is going, and — once it has finished — a folded preview of its latest reply.
 * The **Open** link goes to the job, and the whole card names nothing about the tool that made it.
 */
export function JobCard({ block }: { block: JobBlock }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const live = liveJob(block);
  const now = useNow(live && block.startedAt !== undefined ? 1_000 : null);
  const elapsedMs = live && block.startedAt !== undefined ? now - block.startedAt : undefined;
  const label =
    block.state === "starting" ? (
      <Trans>Starting</Trans>
    ) : block.state === "working" ? (
      <Trans>Working</Trans>
    ) : block.state === "finished" ? (
      <Trans>Finished</Trans>
    ) : block.state === "needs_input" ? (
      <Trans>Needs input</Trans>
    ) : block.state === "timed_out" ? (
      <Trans>Timed out</Trans>
    ) : (
      <Trans>Exited</Trans>
    );
  const reply = block.reply?.trim();
  const href = httpsUrl(block.url);
  return (
    <Card size="sm" className="w-80 max-w-full" data-testid="job-card">
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0 truncate font-medium" dir="auto">
            {block.title}
          </span>
          <Badge
            variant="secondary"
            className={cn("shrink-0 tabular-nums", stateTone(block.state))}
          >
            {label}
            {elapsedMs === undefined ? null : ` ${formatClockDuration(elapsedMs)}`}
          </Badge>
        </div>
        {block.agent || block.branch ? (
          <div className="flex min-w-0 gap-2 text-muted-foreground">
            {block.agent ? (
              <span className="shrink-0 truncate" dir="auto">
                {block.agent}
              </span>
            ) : null}
            {block.branch ? (
              <span className="truncate" dir="auto">
                {block.branch}
              </span>
            ) : null}
          </div>
        ) : null}
        {reply && !live ? (
          <div className="flex flex-col gap-1">
            <p
              className={cn(
                "whitespace-pre-wrap text-muted-foreground wrap-anywhere",
                !open && "line-clamp-3",
              )}
              dir="auto"
            >
              {reply}
            </p>
            {reply.length > PREVIEW_CHARS ? (
              <button
                type="button"
                className="w-fit text-label text-muted-foreground hover:text-foreground"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
              >
                {open ? t`Show less` : t`Show more`}
              </button>
            ) : null}
          </div>
        ) : null}
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-1 text-body-sm text-muted-foreground no-underline hover:text-foreground"
          >
            <Trans>Open</Trans>
            <ExternalLink className="size-3" aria-hidden />
          </a>
        ) : null}
      </CardContent>
    </Card>
  );
}
