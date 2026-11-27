import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNow } from "@rakazo/chat-ui/hooks";
import type { ChatRepository } from "@rakazo/chat-ui/web";
import { ChatMarkdown, resolveJobCommitUrl } from "@rakazo/chat-ui/web";
import type { JobCardFile, JobCardStats, JobCardStep, MessageBlock } from "@rakazo/contracts";
import { httpsUrl } from "@rakazo/core";
import { Button, cn, writeClipboard } from "@rakazo/ui-web";
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
  CheckCircle2,
  ChevronDown,
  Clock,
  Code2,
  Copy,
  Cpu,
  ExternalLink,
  FileDiff,
  FilePenLine,
  GitBranch,
  GitPullRequest,
  Loader2,
  Maximize2,
  MessageSquare,
  RefreshCw,
  Send,
  Square,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  formatClockDuration,
  formatCostUsd,
  formatStepDuration,
} from "../../lib/chat/checkpoint-graph";
import { errorText } from "../../lib/query/user-error";

/** Longest preview of a job's reply that opens on its own, and the most lines it may take. */
const PREVIEW_CHARS = 220;
const PREVIEW_LINES = 3;

/** `Open` leaves the card for the job itself, so it is the one primary action in both footers. */
const OPEN_LINK =
  "inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/75 bg-background/85 px-2.5 py-1 text-label font-medium text-foreground no-underline shadow-2xs transition-colors hover:border-border hover:bg-accent focus-ring";
function OpenLink({ href }: { href: string }) {
  const { t } = useLingui();
  return (
    <a href={href} target="_blank" rel="noreferrer" data-testid="job-open" className={OPEN_LINK}>
      <Trans>Open</Trans>
      <ExternalLink className="size-3" aria-label={t`(opens in a new tab)`} />
    </a>
  );
}

type JobBlock = Extract<MessageBlock, { kind: "job" }>;
type JobTab = "output" | "files" | "steps";
type JobAction = "send" | "stop" | "status";

/** A job card is live while the job runs: its elapsed time counts up from when it started. */
function liveJob(block: JobBlock): boolean {
  return block.state === "starting" || block.state === "working";
}

/** How long a settled job took, when the job reported both ends of its run. */
function finalDuration(block: JobBlock): number | undefined {
  const { startedAt, finishedAt } = block;
  if (startedAt === undefined || finishedAt === undefined) return undefined;
  const ms = finishedAt - startedAt;
  return ms >= 0 ? ms : undefined;
}

/** A short count for a chip: `812`, `8k`, `48.2k`, `1.2M`. */
function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
}

function hasDiffStat(block: JobBlock): boolean {
  const stats = block.stats;
  return (
    (stats?.filesChanged ?? 0) > 0 ||
    (stats?.insertions ?? 0) > 0 ||
    (stats?.deletions ?? 0) > 0 ||
    (block.files?.length ?? 0) > 0
  );
}

function diffStat(block: JobBlock): { files: number; insertions: number; deletions: number } {
  const files =
    block.stats?.filesChanged && block.stats.filesChanged >= (block.files?.length ?? 0)
      ? block.stats.filesChanged
      : (block.files?.length ?? 0);
  const fromFiles = (block.files ?? []).reduce(
    (total, file) => ({
      insertions: total.insertions + (file.insertions ?? 0),
      deletions: total.deletions + (file.deletions ?? 0),
    }),
    { insertions: 0, deletions: 0 },
  );
  return {
    files,
    insertions: Math.max(block.stats?.insertions ?? 0, fromFiles.insertions),
    deletions: Math.max(block.stats?.deletions ?? 0, fromFiles.deletions),
  };
}

function tokenTotal(stats: JobCardStats | undefined): number {
  const input = stats?.inputTokens ?? 0;
  const output = stats?.outputTokens ?? 0;
  return input + output;
}

/** Flash a check beside a control after copying, for a moment and no longer. */
function useCopied(ms = 1_500): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = (text: string) => {
    void writeClipboard(text);
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setCopied(false);
    }, ms);
  };
  return [copied, copy];
}

function stateLabel(state: JobBlock["state"]) {
  if (state === "starting") return <Trans>Starting</Trans>;
  if (state === "working") return <Trans>Working</Trans>;
  if (state === "finished") return <Trans>Finished</Trans>;
  if (state === "needs_input") return <Trans>Needs input</Trans>;
  if (state === "timed_out") return <Trans>Timed out</Trans>;
  return <Trans>Exited</Trans>;
}

/** The pill's tone, kept beside its label so every state reads the same wherever it is drawn. */
function stateTone(state: JobBlock["state"]): string {
  if (state === "finished") return "bg-success/15 text-success";
  if (state === "needs_input") return "bg-warning/15 text-warning";
  if (state === "starting" || state === "working")
    return "bg-status-working/15 text-status-working";
  return "bg-muted text-muted-foreground";
}

/** The thin bar at the top of a card: its whole state, readable at a glance. */
function accentTone(state: JobBlock["state"]): string {
  if (state === "finished") return "bg-success/80";
  if (state === "needs_input") return "bg-warning";
  if (state === "starting" || state === "working")
    return "bg-status-working motion-safe:animate-pulse";
  return "bg-muted-foreground/30";
}

/** The plate behind the card's icon and the icon it holds: a terminal, or code for coding work. */
function iconTone(state: JobBlock["state"]): string {
  if (state === "finished") return "bg-success/12 text-success";
  if (state === "needs_input") return "bg-warning/12 text-warning";
  if (state === "starting" || state === "working")
    return "bg-status-working/12 text-status-working";
  return "bg-muted text-muted-foreground";
}

function StatusPill({
  block,
  live,
  durationMs,
}: {
  block: JobBlock;
  live: boolean;
  durationMs: number | undefined;
}) {
  return (
    <span
      data-testid="job-status"
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-caption font-medium tabular-nums",
        stateTone(block.state),
      )}
    >
      {live ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-status-working motion-safe:animate-[rkPulse_1.2s_ease-in-out_infinite]"
          aria-hidden
        />
      ) : block.state === "finished" ? (
        <CheckCircle2 className="size-3 shrink-0" aria-hidden />
      ) : block.state === "needs_input" ? (
        <AlertCircle className="size-3 shrink-0" aria-hidden />
      ) : block.state === "timed_out" ? (
        <Clock className="size-3 shrink-0" aria-hidden />
      ) : (
        <X className="size-3 shrink-0" aria-hidden />
      )}
      <span className="whitespace-nowrap">{stateLabel(block.state)}</span>
      {durationMs === undefined ? null : (
        <span className="hidden font-mono opacity-80 @[360px]:inline">
          {formatClockDuration(durationMs)}
        </span>
      )}
    </span>
  );
}

/** One file's counts read as `+12`/`-3`, quiet when the job reported nothing for it. */
function LineCounts({ insertions, deletions }: { insertions?: number; deletions?: number }) {
  const hasInsertions = (insertions ?? 0) > 0;
  const hasDeletions = (deletions ?? 0) > 0;
  return (
    <>
      {hasInsertions ? <span className="text-success tabular-nums">+{insertions}</span> : null}
      {hasDeletions ? <span className="text-destructive tabular-nums">-{deletions}</span> : null}
    </>
  );
}

function fileStatusTone(status: JobCardFile["status"]): string {
  if (status === "added") return "bg-success/15 text-success";
  if (status === "deleted") return "bg-destructive/15 text-destructive";
  if (status === "renamed") return "bg-primary/15 text-primary";
  return "bg-warning/15 text-warning";
}

function fileStatusLetter(status: JobCardFile["status"]): string {
  if (status === "added") return "A";
  if (status === "deleted") return "D";
  if (status === "renamed") return "R";
  return "M";
}

/** A unified diff, colored line by line: added, removed, hunk headers, and context. */
export function UnifiedDiffView({ diff }: { diff: string }) {
  return (
    <div
      data-testid="job-diff"
      className="w-full min-w-0 overflow-x-auto border-t border-border/60 bg-muted/20 py-1 font-mono text-[11px] leading-[1.45]"
    >
      {diff.split("\n").map((line, index) => (
        <div
          // A diff has no stable key; its own line index is its identity.
          key={index}
          className={cn(
            "min-w-fit whitespace-pre px-2",
            line.startsWith("@@")
              ? "bg-status-working/10 text-status-working"
              : line.startsWith("+++") || line.startsWith("---")
                ? "text-muted-foreground"
                : line.startsWith("+")
                  ? "bg-success/12 text-success"
                  : line.startsWith("-")
                    ? "bg-destructive/12 text-destructive"
                    : "text-muted-foreground",
          )}
        >
          {line === "" ? " " : line}
        </div>
      ))}
    </div>
  );
}

function FileRow({ file }: { file: JobCardFile }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [copied, copy] = useCopied();
  const hasDiff = Boolean(file.diff);
  // The filename keeps its room and the directory gives way, so a long path still reads.
  const cut = file.path.lastIndexOf("/") + 1;
  const directory = file.path.slice(0, cut);
  const name = file.path.slice(cut);
  return (
    <div data-testid="job-file" className="group/file min-w-0 transition-colors hover:bg-muted/35">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
        <span
          className={cn(
            "grid size-4 shrink-0 place-items-center rounded-[4px] font-mono text-[10px] font-semibold",
            fileStatusTone(file.status),
          )}
          aria-hidden
        >
          {fileStatusLetter(file.status)}
        </span>
        <button
          type="button"
          disabled={!hasDiff}
          aria-expanded={hasDiff ? open : undefined}
          onClick={() => setOpen((current) => !current)}
          title={file.path}
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-start focus-ring disabled:cursor-default"
        >
          <span className="flex min-w-0 flex-1 items-baseline font-mono text-caption">
            {directory ? (
              <span className="min-w-0 truncate text-muted-foreground">{directory}</span>
            ) : null}
            <span className="shrink-0 font-medium text-foreground">{name}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-caption">
            <LineCounts insertions={file.insertions} deletions={file.deletions} />
          </span>
          {hasDiff ? (
            <ChevronDown
              className={cn(
                "size-3 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                open && "rotate-180",
              )}
              aria-hidden
            />
          ) : null}
        </button>
        <button
          type="button"
          aria-label={copied ? t`Copied` : t`Copy path`}
          onClick={() => copy(file.path)}
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-45 transition-opacity group-hover/file:opacity-100 hover:text-foreground focus-ring focus-visible:opacity-100"
        >
          {copied ? (
            <Check className="size-3" aria-hidden />
          ) : (
            <Copy className="size-3" aria-hidden />
          )}
        </button>
      </div>
      {open && file.diff ? <UnifiedDiffView diff={file.diff} /> : null}
    </div>
  );
}

function FileList({ files }: { files: readonly JobCardFile[] }) {
  return (
    <div className="flex min-w-0 flex-col divide-y divide-border/45 overflow-hidden rounded-xl border border-border/50 bg-background/35">
      {files.map((file, index) => (
        <FileRow key={`${file.path}-${index}`} file={file} />
      ))}
    </div>
  );
}

function stepIcon(kind: JobCardStep["kind"]) {
  if (kind === "command") return Terminal;
  if (kind === "edit") return FilePenLine;
  if (kind === "note") return MessageSquare;
  return Wrench;
}

function StepStatus({ status }: { status: JobCardStep["status"] }) {
  if (status === "ok") return <Check className="size-3 shrink-0 text-success" aria-hidden />;
  if (status === "error") return <X className="size-3 shrink-0 text-destructive" aria-hidden />;
  if (status === "running")
    return <Loader2 className="size-3 shrink-0 animate-spin text-status-working" aria-hidden />;
  return <span className="size-1 shrink-0 rounded-full bg-muted-foreground/50" aria-hidden />;
}

function StepRow({ step }: { step: JobCardStep }) {
  const [open, setOpen] = useState(false);
  const Icon = stepIcon(step.kind);
  const detail = step.detail?.trim();
  const duration = formatStepDuration(step.durationMs);
  return (
    <li data-testid="job-step" className="min-w-0 rounded-md px-2 py-1.5 hover:bg-muted/40">
      <button
        type="button"
        disabled={!detail}
        aria-expanded={detail ? open : undefined}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full min-w-0 items-center gap-2 rounded text-start focus-ring disabled:cursor-default"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-body-sm text-foreground/90" title={step.name}>
          {step.name}
        </span>
        {duration ? (
          <span className="shrink-0 font-mono text-caption text-muted-foreground tabular-nums">
            {duration}
          </span>
        ) : null}
        <StepStatus status={step.status} />
        {detail ? (
          <ChevronDown
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
              open && "rotate-180",
            )}
            aria-hidden
          />
        ) : null}
      </button>
      {open && detail ? (
        <code className="mt-1 block max-h-32 overflow-y-auto rounded bg-muted/50 px-2 py-1 font-mono text-[11px] leading-[1.45] break-words whitespace-pre-wrap text-muted-foreground">
          {detail}
        </code>
      ) : null}
    </li>
  );
}

function ActivityList({ steps }: { steps: readonly JobCardStep[] }) {
  return (
    <ol className="flex min-w-0 flex-col rounded-xl border border-border/45 bg-background/25 p-1">
      {steps.map((step, index) => (
        <StepRow key={`${step.name}-${index}`} step={step} />
      ))}
    </ol>
  );
}

/** The job's own words, with code, lists and headings drawn rather than shown as plain text. */
function OutputBody({
  reply,
  foldable,
  copyable = false,
  label,
}: {
  reply: string;
  foldable: boolean;
  /** Draws a Copy button beside the fold control: the inspector has no footer of its own. */
  copyable?: boolean;
  /** Names what is copied, such as the job's output inside the inspector. */
  label?: string;
}) {
  const { t } = useLingui();
  const longEnough = reply.length > PREVIEW_CHARS || reply.split("\n").length > PREVIEW_LINES;
  const [open, setOpen] = useState(false);
  const [copied, copy] = useCopied();
  const canFold = foldable && longEnough;
  const folded = canFold && !open;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className={cn("relative min-w-0", folded && "max-h-36 overflow-hidden")}>
        <div
          data-testid="job-output"
          className="min-w-0 text-body-sm leading-relaxed text-foreground/90 wrap-anywhere [&_[data-slot=katex-display]]:overflow-x-auto"
          dir="auto"
        >
          <ChatMarkdown>{reply}</ChatMarkdown>
        </div>
        {folded ? (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-card to-transparent"
            aria-hidden
          />
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {canFold ? (
          <button
            type="button"
            data-testid="job-reply-toggle"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
            className="w-fit text-label text-muted-foreground hover:text-foreground focus-ring"
          >
            {open ? t`Show less` : t`Show more`}
          </button>
        ) : null}
        {copyable ? (
          <button
            type="button"
            data-testid="job-output-copy"
            aria-label={copied ? t`Copied` : (label ?? t`Copy output`)}
            onClick={() => copy(reply)}
            className="inline-flex w-fit items-center gap-1 text-label text-muted-foreground hover:text-foreground focus-ring"
          >
            {copied ? (
              <Check className="size-3" aria-hidden />
            ) : (
              <Copy className="size-3" aria-hidden />
            )}
            {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** The compact composer that steers a running job or answers one waiting on a person. */
function JobComposer({
  block,
  pending,
  onSend,
  onClose,
}: {
  block: JobBlock;
  pending: boolean;
  onSend: (text: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const live = liveJob(block);
  // The reader asked for the composer, so the caret starts in it: Enter sends, Escape closes.
  useEffect(() => {
    input.current?.focus();
  }, []);
  const submit = () => {
    const text = draft.trim();
    if (!text || pending) return;
    setError(null);
    onSend(text).catch((failure: unknown) => {
      setError(errorText(failure, t`Could not send the instruction.`));
    });
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="job-composer">
      <div className="flex min-w-0 items-end gap-1.5">
        <textarea
          ref={input}
          data-testid="job-composer-input"
          aria-label={t`Instruction for ${block.title}`}
          placeholder={live ? t`Steer ${block.title}…` : t`Send instruction to ${block.title}…`}
          rows={1}
          value={draft}
          disabled={pending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
          className="min-h-8 max-h-28 min-w-0 flex-1 field-sizing-content resize-none rounded-lg border border-input bg-background/80 px-2.5 py-1.5 text-[16px]/5 text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60 md:text-body-sm"
        />
        <Button
          type="button"
          size="icon-sm"
          variant="secondary"
          data-testid="job-composer-send"
          aria-label={t`Send instruction`}
          disabled={pending || !draft.trim()}
          onClick={submit}
        >
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
        </Button>
      </div>
      {error ? (
        <p data-testid="job-composer-error" className="text-caption text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function MetaChip({
  icon,
  children,
  title,
  onClick,
  testId,
}: {
  icon?: ReactNode;
  children: ReactNode;
  title?: string;
  onClick?: () => void;
  testId: string;
}) {
  const className = cn(
    "inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border/45 bg-muted/45 px-2 py-0.5 text-caption text-muted-foreground",
    onClick
      ? "cursor-pointer transition-colors hover:border-border hover:bg-muted hover:text-foreground focus-ring"
      : undefined,
  );
  const content = (
    <>
      {icon ? (
        <span className="shrink-0 [&_svg]:size-3" aria-hidden>
          {icon}
        </span>
      ) : null}
      {children}
    </>
  );
  return onClick ? (
    <button
      type="button"
      className={className}
      title={title}
      onClick={onClick}
      data-testid={testId}
    >
      {content}
    </button>
  ) : (
    <span className={className} title={title} data-testid={testId}>
      {content}
    </span>
  );
}

/** Opens the job at its own address, adding `?job=<jobId>` only to a legacy bare origin. */
function jobOpenUrl(rawUrl: string | undefined, jobId: string): string | undefined {
  const safe = httpsUrl(rawUrl);
  const trimmedId = jobId.trim();
  if (!safe || !trimmedId) return safe;
  // `httpsUrl` parsed this address already, so a stored deep link simply keeps its own route.
  const parsed = new URL(safe);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return safe;
  parsed.searchParams.set("job", trimmedId);
  return parsed.toString();
}

/** The plate and icon at a card's head, so the card and its inspector read alike. */
function JobIcon({ block }: { block: JobBlock }) {
  const Icon = block.files?.length || block.steps?.length ? Code2 : Terminal;
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg",
        iconTone(block.state),
      )}
      aria-hidden
    >
      <Icon className="size-4" strokeWidth={1.9} />
    </span>
  );
}

/**
 * A job a tool started somewhere else, drawn from that tool's own result: what it is, who is
 * doing it, how it is going, and what it produced. A live job counts its clock up, a finished
 * one shows what it took; the tabs below it hold the output, the files it changed and the steps
 * it took, and its footer steers the job or opens it where it runs. The whole card names nothing
 * about the tool that made it.
 */
export function JobCard({
  block,
  repositories,
  readOnly = false,
  onJobAction,
}: {
  block: JobBlock;
  /** The Space's board repositories, which link a commit when the job's own address does not. */
  repositories?: readonly ChatRepository[];
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
  const [pending, setPending] = useState<JobAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [branchCopied, copyBranch] = useCopied();
  const [pathCopied, copyPath] = useCopied();
  const [outputCopied, copyOutput] = useCopied();

  const reply = block.reply?.trim();
  const href = jobOpenUrl(block.url, block.jobId);
  const prHref = httpsUrl(block.prUrl);
  const commitHref = resolveJobCommitUrl(block, repositories);
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

  const runAction = (action: JobAction, text: string) => {
    if (!onJobAction || pending) return;
    setPending(action);
    setActionError(null);
    onJobAction(text)
      .catch((failure: unknown) => {
        setActionError(errorText(failure, t`Could not reach the job.`));
      })
      .finally(() => {
        setPending((current) => (current === action ? null : current));
      });
  };
  const jobRef = `"${block.title}" (${block.jobId})`;
  const composer =
    composerOpen && canAct && onJobAction ? (
      <JobComposer
        block={block}
        pending={pending === "send"}
        onClose={() => setComposerOpen(false)}
        onSend={async (text) => {
          setPending("send");
          setActionError(null);
          try {
            await onJobAction(
              live
                ? t`Steer Orca job ${jobRef}: ${text}`
                : t`[Job: ${block.title} (${block.jobId})] ${text}`,
            );
            setComposerOpen(false);
          } finally {
            setPending((current) => (current === "send" ? null : current));
          }
        }}
      />
    ) : null;

  /** Toggle the inline composer that steers, answers or follows up on the job. */
  const toggleComposer = () => setComposerOpen((current) => !current);

  const agentLine = [block.agent, block.model, block.effort].filter(Boolean).join(" · ");
  const commitAnchor =
    block.commit && commitHref ? (
      <a
        href={commitHref}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="job-commit-link"
        className="font-mono underline-offset-2 hover:underline"
        onClick={(event) => event.stopPropagation()}
      >
        {block.commit.slice(0, 7)}
      </a>
    ) : null;
  // A branch chip is a button, which cannot hold a link, so a linked commit sits beside it.
  const branchOrCommit = block.branch ? (
    <>
      <MetaChip
        icon={branchCopied ? <Check /> : <GitBranch />}
        title={branchCopied ? t`Branch copied` : t`Copy branch name`}
        testId="job-meta-branch"
        onClick={() => copyBranch(block.branch!)}
      >
        <span className="min-w-0 truncate font-mono" dir="auto">
          {block.branch}
        </span>
        {block.commit && !commitHref ? (
          <span className="shrink-0 font-mono text-caption text-muted-foreground/70">
            {block.commit.slice(0, 7)}
          </span>
        ) : null}
      </MetaChip>
      {commitAnchor ? (
        <span className="shrink-0 text-caption text-muted-foreground">{commitAnchor}</span>
      ) : null}
    </>
  ) : block.commit ? (
    <MetaChip icon={<GitBranch />} testId="job-meta-commit">
      {commitAnchor ?? <span className="font-mono">{block.commit.slice(0, 7)}</span>}
    </MetaChip>
  ) : null;
  const leadingMeta = (
    <>
      {agentLine ? (
        <MetaChip
          icon={block.model || block.effort ? <Cpu /> : <Terminal />}
          testId="job-meta-agent"
        >
          <span className="min-w-0 truncate" dir="auto">
            {agentLine}
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
            .join(" · ")}
        >
          <span className="tabular-nums">
            {tokens > 0 ? t`${compactCount(tokens)} tok` : null}
            {tokens > 0 && cost ? " · " : null}
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
                  disabled={pending === "stop"}
                  onClick={() => runAction("stop", t`Stop Orca job ${jobRef}.`)}
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  {pending === "stop" ? (
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
                  disabled={pending === "status"}
                  onClick={() => runAction("status", t`Check status of Orca job ${jobRef}.`)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {pending === "status" ? (
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
          {actionError ? (
            <p data-testid="job-action-error" className="text-caption text-destructive">
              {actionError}
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
                {block.repo ? `${block.repo} · ` : null}
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
