import { useLingui } from "@lingui/react/macro";
import type { JobCardFile } from "@rakazo/contracts";
import { cn } from "@rakazo/ui-web";
import { Check, ChevronDown, Copy } from "lucide-react";
import { useState } from "react";
import { useCopied } from "./job-card-helpers";

/** One file's counts read as `+12`/`-3`, quiet when the job reported nothing for it. */
export function LineCounts({ insertions, deletions }: { insertions?: number; deletions?: number }) {
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
function UnifiedDiffView({ diff }: { diff: string }) {
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

export function FileList({ files }: { files: readonly JobCardFile[] }) {
  return (
    <div className="flex min-w-0 flex-col divide-y divide-border/45 overflow-hidden rounded-xl border border-border/50 bg-background/35">
      {files.map((file, index) => (
        <FileRow key={`${file.path}-${index}`} file={file} />
      ))}
    </div>
  );
}
