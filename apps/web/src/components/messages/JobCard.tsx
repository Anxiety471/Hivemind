import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNow } from "@rakazo/chat-ui/hooks";
import { httpsUrl } from "@rakazo/core";
import { Button, cn } from "@rakazo/ui-web";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@rakazo/ui-web/components/ui/dialog";
import {
  AlertCircle,
  Check,
  Clock,
  Copy,
  Cpu,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitPullRequest,
  Loader2,
  Maximize2,
  MessageSquare,
  RefreshCw,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { Fragment, useState } from "react";
import { formatCostUsd } from "../../lib/chat/checkpoint-graph";
import { useSave } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { ActivityList } from "./jobcard/job-card-activity";
import { Dot, MetaChip, OpenLink } from "./jobcard/job-card-chrome";
import { JobComposer } from "./jobcard/job-card-composer";
import { FileList, LineCounts } from "./jobcard/job-card-files";
import type { JobAction, JobBlock, JobTab } from "./jobcard/job-card-helpers";
import {
  compactCount,
  diffStat,
  finalDuration,
  hasDiffStat,
  jobOpenUrl,
  liveJob,
  tokenTotal,
  useCopied,
} from "./jobcard/job-card-helpers";
import { OutputBody } from "./jobcard/job-card-output";
import { accentTone, JobIcon, StatusPill } from "./jobcard/job-card-status";

/**
 * A job a tool started somewhere else, drawn from that tool's own result: what it is, who is
 * doing it, how it is going, and what it produced. A live job counts its clock up, a finished
 * one shows what it took; the tabs below it hold the output, the files it changed and the steps
 * it took, and its footer steers the job or opens it where it runs. The whole card names nothing
 * about the tool that made it.
 */
export function JobCard({
  block,
  readOnly = false,
  onJobAction,
}: {
  block: JobBlock;
  /** A helper's own thread: the card shows its job but never acts on it. */
  readOnly?: boolean;
  /** Sends text into the chat's own thread, as if the reader had typed it there. */
  onJobAction?: (text: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const live = liveJob(block);
  const now = useNow(live && block.startedAt !== undefined ? 1_000 : null);
  const elapsedMs = live && block.startedAt !== undefined ? now - block.startedAt : undefined;
  const durationMs = live ? elapsedMs : finalDuration(block);
  const [tab, setTab] = useState<JobTab>(() =>
    live
      ? block.steps?.length
        ? "steps"
        : block.files?.length
          ? "files"
          : "output"
      : block.reply
        ? "output"
        : block.files?.length
          ? "files"
          : "steps",
  );
  const [inspecting, setInspecting] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [branchCopied, copyBranch] = useCopied();
  const [pathCopied, copyPath] = useCopied();
  const [outputCopied, copyOutput] = useCopied();

  const reply = block.reply?.trim();
  const href = jobOpenUrl(block.url, block.jobId);
  const prHref = httpsUrl(block.prUrl);
  const files = block.files ?? [];
  const steps = block.steps ?? [];
  const stats = block.stats;
  const tokens = tokenTotal(stats);
  const cost = formatCostUsd(stats?.costUsd);
  const diff = diffStat(block);
  const canAct = !readOnly && Boolean(onJobAction);
  const needsInput = block.state === "needs_input";
  // While it works, the bar shows what it is doing and how much it has done.
  const toolCalls = (stats?.toolCalls ?? 0) > 0 ? stats?.toolCalls : undefined;
  const stepCount = toolCalls ?? (steps.length > 0 ? steps.length : undefined);
  const stepLabel =
    toolCalls !== undefined
      ? plural(toolCalls, { one: "# tool", other: "# tools" })
      : plural(steps.length, { one: "# step", other: "# steps" });
  const hasMeta = Boolean(
    block.agent || block.model || block.effort || block.branch || block.commit || prHref,
  );
  const hasOutput = Boolean(reply || block.summary || block.workspacePath || block.currentActivity);
  const hasDetails = Boolean(
    hasOutput || hasMeta || files.length || steps.length || block.error || tokens > 0 || cost,
  );
  const sections: JobTab[] = [];
  // A paused job shows its question in the output like any other, with no special case.
  if (reply) sections.push("output");
  if (files.length > 0) sections.push("files");
  if (steps.length > 0) sections.push("steps");
  const activeTab: JobTab = sections.includes(tab) ? tab : (sections[0] ?? "output");
  const copyText = reply ?? block.workspacePath;

  // A send or a footer action goes out through the chat's own sender, one at a time.
  const action = useSave<{ action: JobAction; message: string }>({
    save: async ({ message }) => {
      await onJobAction?.(message);
    },
    onSaved: (_saved, { action: sent }) => {
      if (sent === "send") setComposerOpen(false);
    },
  });
  const pendingAction = action.pending ? action.input?.action : undefined;
  const failure = action.error
    ? errorText(
        action.error,
        action.input?.action === "send"
          ? t`Could not send the instruction.`
          : t`Could not reach the job.`,
      )
    : null;
  // Closing the composer forgets its last failure, so the next open starts clean.
  const closeComposer = () => {
    setComposerOpen(false);
    action.reset();
  };
  const runAction = (kind: JobAction, message: string) => {
    if (!onJobAction) return;
    action.run({ action: kind, message });
  };
  const jobRef = `"${block.title}" (${block.jobId})`;
  const composer =
    composerOpen && canAct && onJobAction ? (
      <JobComposer
        block={block}
        pending={pendingAction === "send"}
        error={action.input?.action === "send" ? failure : null}
        onClose={closeComposer}
        onSend={(text) =>
          runAction(
            "send",
            live
              ? t`Steer Orca job ${jobRef}: ${text}`
              : t`[Job: ${block.title} (${block.jobId})] ${text}`,
          )
        }
      />
    ) : null;

  /** Toggle the inline composer that steers, answers or follows up on the job. */
  const toggleComposer = () => (composerOpen ? closeComposer() : setComposerOpen(true));

  const agentParts = [block.agent, block.model, block.effort].filter(Boolean);
  const branchOrCommit = block.branch ? (
    <MetaChip
      icon={branchCopied ? <Check /> : <GitBranch />}
      title={branchCopied ? t`Branch copied` : t`Copy branch name`}
      testId="job-meta-branch"
      onClick={() => copyBranch(block.branch!)}
    >
      <span className="min-w-0 truncate font-mono" dir="auto">
        {block.branch}
      </span>
      {block.commit ? (
        <span className="shrink-0 font-mono text-caption text-muted-foreground/70">
          {block.commit.slice(0, 7)}
        </span>
      ) : null}
    </MetaChip>
  ) : block.commit ? (
    <MetaChip icon={<GitBranch />} testId="job-meta-commit">
      <span className="font-mono">{block.commit.slice(0, 7)}</span>
    </MetaChip>
  ) : null;
  const leadingMeta = (
    <>
      {agentParts.length > 0 ? (
        <MetaChip
          icon={block.model || block.effort ? <Cpu /> : <Terminal />}
          testId="job-meta-agent"
        >
          <span className="inline-flex min-w-0 items-center" dir="auto">
            {agentParts.map((part, index) => (
              // A part keeps its place in the line, so its position is its identity.
              <Fragment key={index}>
                {index > 0 ? <Dot /> : null}
                <span className="min-w-0 truncate">{part}</span>
              </Fragment>
            ))}
          </span>
        </MetaChip>
      ) : null}
      {branchOrCommit}
      {prHref ? (
        <a
          href={prHref}
          target="_blank"
          rel="noreferrer"
          data-testid="job-pr-link"
          className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border/45 bg-muted/45 px-2 py-0.5 text-caption text-muted-foreground no-underline transition-colors hover:border-border hover:bg-muted hover:text-foreground focus-ring"
        >
          <GitPullRequest className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{block.prLabel ?? t`PR`}</span>
          <ExternalLink className="size-2.5 shrink-0 opacity-70" aria-hidden />
        </a>
      ) : null}
    </>
  );
  const trailingMeta = (
    <>
      {hasDiffStat(block) ? (
        <MetaChip
          icon={<FileDiff />}
          testId="job-meta-diff"
          title={t`Inspect changed files`}
          onClick={files.length > 0 ? () => setTab("files") : undefined}
        >
          <span className="tabular-nums">
            {plural(diff.files, { one: "# file", other: "# files" })}
          </span>
          <LineCounts insertions={diff.insertions} deletions={diff.deletions} />
        </MetaChip>
      ) : null}
      {tokens > 0 || cost ? (
        <MetaChip
          testId="job-meta-tokens"
          title={[
            stats?.inputTokens === undefined
              ? undefined
              : t`Input ${stats.inputTokens.toLocaleString()}`,
            stats?.outputTokens === undefined
              ? undefined
              : t`Output ${stats.outputTokens.toLocaleString()}`,
          ]
            .filter(Boolean)
            .join("\n")}
        >
          <span className="inline-flex items-center tabular-nums">
            {tokens > 0 ? t`${compactCount(tokens)} tok` : null}
            {tokens > 0 && cost ? <Dot /> : null}
            {cost ? <span className="text-foreground/70">{cost}</span> : null}
          </span>
        </MetaChip>
      ) : null}
    </>
  );

  const subtitle = block.summary?.trim();
  return (
    <div
      data-testid="job-card"
      className="@container w-full overflow-hidden rounded-2xl border border-border bg-card shadow-sm"
    >
      <div data-testid="job-accent" className={cn("h-0.5 w-full", accentTone(block.state))} />
      <div className="flex flex-col gap-2 px-4 pt-3.5 pb-3">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <JobIcon block={block} />
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  className="min-w-0 truncate text-body font-medium text-foreground @[380px]:text-body-lg"
                  dir="auto"
                  title={block.title}
                >
                  {block.title}
                </span>
                {block.repo && block.repo !== block.title ? (
                  <span
                    className="hidden max-w-[14rem] shrink-0 truncate rounded-md border border-border/50 bg-muted/40 px-1.5 py-0.5 font-mono text-caption text-muted-foreground @[520px]:inline-block"
                    dir="auto"
                    title={block.repo}
                  >
                    {block.repo}
                  </span>
                ) : null}
                {block.turn !== undefined ? (
                  <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-caption text-muted-foreground tabular-nums">
                    {t`Turn ${block.turn}`}
                  </span>
                ) : null}
              </div>
              {subtitle ? (
                <p
                  className="mt-0.5 truncate text-body-sm text-muted-foreground"
                  dir="auto"
                  title={subtitle}
                >
                  {subtitle}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <StatusPill block={block} live={live} durationMs={durationMs} />
            {hasDetails ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                data-testid="job-inspect"
                aria-label={t`Inspect job details`}
                title={t`Inspect job details`}
                // The only way into the full-screen inspector, so it stays on every card width.
                className="text-muted-foreground"
                onClick={() => setInspecting(true)}
              >
                <Maximize2 aria-hidden />
              </Button>
            ) : null}
          </div>
        </div>

        {hasMeta || tokens > 0 || cost || hasDiffStat(block) ? (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 pt-0.5">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">{leadingMeta}</div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">{trailingMeta}</div>
          </div>
        ) : null}
      </div>

      {live ? (
        <div
          data-testid="job-live-status"
          className="mx-4 mb-2.5 flex min-w-0 items-center justify-between gap-2.5 rounded-lg border border-status-working/25 bg-status-working/8 px-3 py-2"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Loader2 className="size-3.5 shrink-0 animate-spin text-status-working" aria-hidden />
            {block.currentActivity ? (
              <span
                className="min-w-0 truncate font-mono text-caption text-foreground/90"
                dir="auto"
                title={block.currentActivity}
              >
                {block.currentActivity}
              </span>
            ) : (
              <span className="min-w-0 truncate text-caption text-foreground/90">
                {block.state === "starting" ? (
                  <Trans>Starting agent…</Trans>
                ) : (
                  <Trans>Working on task…</Trans>
                )}
              </span>
            )}
          </span>
          {stepCount === undefined ? null : (
            <span
              data-testid="job-live-steps"
              className="shrink-0 text-caption text-muted-foreground tabular-nums"
            >
              {stepLabel}
            </span>
          )}
        </div>
      ) : needsInput || block.error ? (
        <div
          data-testid="job-status-note"
          className={cn(
            "mx-4 mb-2.5 flex min-w-0 flex-col gap-1 rounded-lg border px-3 py-2",
            needsInput
              ? "border-warning/25 bg-warning/8"
              : "border-destructive/25 bg-destructive/8",
          )}
        >
          {block.currentActivity ? (
            <span className="flex min-w-0 items-center gap-2">
              {needsInput ? (
                <AlertCircle className="size-3.5 shrink-0 text-warning" aria-hidden />
              ) : (
                <X className="size-3.5 shrink-0 text-destructive" aria-hidden />
              )}
              <span
                data-testid="job-status-activity"
                className="min-w-0 flex-1 truncate font-mono text-caption text-foreground/90"
                dir="auto"
                title={block.currentActivity}
              >
                {block.currentActivity}
              </span>
            </span>
          ) : needsInput ? (
            <span className="flex min-w-0 items-center gap-2">
              <Clock className="size-3.5 shrink-0 text-warning" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-caption text-foreground/90">
                <Trans>Paused, waiting for your reply…</Trans>
              </span>
            </span>
          ) : null}
          {block.error ? (
            <p
              data-testid="job-error"
              className={cn(
                "min-w-0 text-caption break-words",
                needsInput ? "text-foreground/90" : "text-destructive",
              )}
              dir="auto"
            >
              {block.error}
            </p>
          ) : null}
        </div>
      ) : null}

      {sections.length > 0 ? (
        <div className="min-w-0 border-t border-border/60">
          {sections.length > 1 ? (
            <div
              role="tablist"
              aria-label={t`Job details`}
              className="flex min-w-0 items-center gap-1 border-b border-border/60 bg-muted/20 px-4 py-1.5"
            >
              {sections.map((section) => (
                <button
                  key={section}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === section}
                  data-testid={`job-tab-${section}`}
                  onClick={() => setTab(section)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-label transition-colors focus-ring",
                    activeTab === section
                      ? "bg-background text-foreground shadow-2xs ring-1 ring-border/50"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {section === "output" ? (
                    <Trans>Output</Trans>
                  ) : section === "files" ? (
                    <>
                      <Trans>Files</Trans>
                      <span className="tabular-nums text-muted-foreground">{files.length}</span>
                    </>
                  ) : (
                    <>
                      <Trans>Activity</Trans>
                      <span className="tabular-nums text-muted-foreground">{steps.length}</span>
                    </>
                  )}
                </button>
              ))}
            </div>
          ) : null}
          <div
            data-testid={`job-panel-${activeTab}`}
            role="tabpanel"
            aria-label={t`Job details`}
            className="min-w-0 px-4 py-3"
          >
            {activeTab === "output" && reply ? (
              <OutputBody reply={reply} foldable />
            ) : activeTab === "files" ? (
              <div className="max-h-72 min-w-0 overflow-y-auto scroll-py-1 rk-scroll">
                <FileList files={files} />
              </div>
            ) : activeTab === "steps" ? (
              <div className="max-h-72 min-w-0 overflow-y-auto scroll-py-1 rk-scroll">
                <ActivityList steps={steps} />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {canAct || copyText || hasDetails || href ? (
        <div className="flex min-w-0 flex-col gap-2 border-t border-border/60 bg-muted/20 px-4 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1">
              {canAct ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  data-testid="job-steer"
                  aria-expanded={composerOpen}
                  onClick={toggleComposer}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <MessageSquare aria-hidden />
                  {live ? (
                    <Trans>Steer</Trans>
                  ) : needsInput ? (
                    <Trans>Reply</Trans>
                  ) : (
                    <Trans>Follow up</Trans>
                  )}
                </Button>
              ) : null}
              {canAct && (live || needsInput) ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  data-testid="job-stop"
                  disabled={pendingAction === "stop"}
                  onClick={() => runAction("stop", t`Stop Orca job ${jobRef}.`)}
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  {pendingAction === "stop" ? (
                    <Loader2 className="animate-spin" aria-hidden />
                  ) : (
                    <Square aria-hidden />
                  )}
                  <Trans>Stop</Trans>
                </Button>
              ) : null}
              {canAct && block.state === "timed_out" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  data-testid="job-status-check"
                  disabled={pendingAction === "status"}
                  onClick={() => runAction("status", t`Check status of Orca job ${jobRef}.`)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {pendingAction === "status" ? (
                    <Loader2 className="animate-spin" aria-hidden />
                  ) : (
                    <RefreshCw aria-hidden />
                  )}
                  <Trans>Check status</Trans>
                </Button>
              ) : null}
            </div>
            <div className="flex min-w-0 items-center gap-0.5">
              {copyText ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  data-testid="job-copy"
                  aria-label={
                    outputCopied ? t`Copied` : reply ? t`Copy job output` : t`Copy workspace path`
                  }
                  title={outputCopied ? t`Copied` : reply ? t`Copy output` : t`Copy workspace path`}
                  className={cn("text-muted-foreground", outputCopied && "text-success")}
                  onClick={() => copyOutput(copyText)}
                >
                  {outputCopied ? <Check aria-hidden /> : <Copy aria-hidden />}
                </Button>
              ) : null}
              {href ? <OpenLink href={href} /> : null}
            </div>
          </div>
          {composer}
          {failure && action.input?.action !== "send" ? (
            <p data-testid="job-action-error" className="text-caption text-destructive">
              {failure}
            </p>
          ) : null}
        </div>
      ) : null}

      {hasDetails ? (
        <Dialog open={inspecting} onOpenChange={setInspecting}>
          <DialogContent
            size="xl"
            className="@container flex h-[min(88vh,760px)] w-[min(920px,94vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(920px,94vw)]"
          >
            <DialogHeader className="flex shrink-0 flex-col gap-2 border-b border-border px-5 py-4 pr-14">
              <div className="flex min-w-0 items-center gap-2">
                <JobIcon block={block} />
                <DialogTitle className="min-w-0 flex-1 truncate" dir="auto">
                  {block.title}
                </DialogTitle>
                <StatusPill block={block} live={live} durationMs={durationMs} />
              </div>
              <DialogDescription className="sr-only">
                <Trans>Job details</Trans>
              </DialogDescription>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                {leadingMeta}
                {trailingMeta}
              </div>
              {block.workspacePath ? (
                <button
                  type="button"
                  data-testid="job-workspace-path"
                  onClick={() => copyPath(block.workspacePath!)}
                  title={t`Copy workspace path`}
                  className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border/45 bg-muted/45 px-2 py-0.5 text-caption text-muted-foreground hover:text-foreground focus-ring"
                >
                  {pathCopied ? (
                    <Check className="size-3 shrink-0" aria-hidden />
                  ) : (
                    <Copy className="size-3 shrink-0" aria-hidden />
                  )}
                  <span className="min-w-0 truncate font-mono" dir="auto">
                    {block.workspacePath}
                  </span>
                </button>
              ) : null}
            </DialogHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 rk-scroll">
              {subtitle ? (
                <p className="min-w-0 text-body-sm text-muted-foreground wrap-anywhere" dir="auto">
                  {subtitle}
                </p>
              ) : null}
              {block.error ? (
                <div
                  className={cn(
                    "min-w-0 rounded-lg border px-2.5 py-1.5 text-body-sm wrap-anywhere",
                    block.state === "needs_input"
                      ? "border-warning/30 bg-warning/10 text-warning"
                      : "border-destructive/30 bg-destructive/10 text-destructive",
                  )}
                  dir="auto"
                >
                  {block.error}
                </div>
              ) : null}
              {reply ? (
                <section data-testid="job-dialog-output" className="flex min-w-0 flex-col gap-1">
                  <h3 className="text-label font-medium text-muted-foreground">
                    <Trans>Output</Trans>
                  </h3>
                  <OutputBody reply={reply} foldable={false} copyable label={t`Copy output`} />
                </section>
              ) : null}
              {files.length > 0 ? (
                <section data-testid="job-dialog-files" className="flex min-w-0 flex-col gap-1">
                  <h3 className="text-label font-medium text-muted-foreground">
                    <Trans>Files changed</Trans>
                  </h3>
                  <FileList files={files} />
                </section>
              ) : null}
              {steps.length > 0 ? (
                <section data-testid="job-dialog-steps" className="flex min-w-0 flex-col gap-1">
                  <h3 className="text-label font-medium text-muted-foreground">
                    <Trans>Activity</Trans>
                  </h3>
                  <ActivityList steps={steps} />
                </section>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-muted/20 px-5 py-3">
              <span className="min-w-0 truncate font-mono text-caption text-muted-foreground">
                {block.repo ? (
                  <>
                    {block.repo}
                    <Dot />
                  </>
                ) : null}
                {block.branch ?? block.jobId}
              </span>
              {href ? <OpenLink href={href} /> : null}
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
