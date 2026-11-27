import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { JobCardStats, MessageBlock } from "@rakazo/contracts";
import { httpsUrl } from "@rakazo/core";
import { writeClipboard } from "@rakazo/ui-web";
import { useState } from "react";

export type JobBlock = Extract<MessageBlock, { kind: "job" }>;

export type JobTab = "output" | "files" | "steps";

export type JobAction = "send" | "stop" | "status";

/** A job card is live while the job runs: its elapsed time counts up from when it started. */
export function liveJob(block: JobBlock): boolean {
  return block.state === "starting" || block.state === "working";
}

/** How long a settled job took, when the job reported both ends of its run. */
export function finalDuration(block: JobBlock): number | undefined {
  const { startedAt, finishedAt } = block;
  if (startedAt === undefined || finishedAt === undefined) return undefined;
  const ms = finishedAt - startedAt;
  return ms >= 0 ? ms : undefined;
}

/** A short count for a chip: `812`, `8k`, `48.2k`, `1.2M`. */
export function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
}

export function hasDiffStat(block: JobBlock): boolean {
  const stats = block.stats;
  return (
    (stats?.filesChanged ?? 0) > 0 ||
    (stats?.insertions ?? 0) > 0 ||
    (stats?.deletions ?? 0) > 0 ||
    (block.files?.length ?? 0) > 0
  );
}

export function diffStat(block: JobBlock): {
  files: number;
  insertions: number;
  deletions: number;
} {
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

export function tokenTotal(stats: JobCardStats | undefined): number {
  const input = stats?.inputTokens ?? 0;
  const output = stats?.outputTokens ?? 0;
  return input + output;
}

/** Flash a check beside a control after copying, for a moment and no longer. */
export function useCopied(ms = 1_500): [boolean, (text: string) => void] {
  // Each copy hands out a new mark, so a second copy restarts the wait instead of ending the first.
  const [mark, setMark] = useState<object | null>(null);
  useTimeout(() => setMark(null), mark ? ms : null, mark);
  const copy = (text: string) => {
    void writeClipboard(text);
    setMark({});
  };
  return [mark !== null, copy];
}

/** Opens the job at its own address, adding `?job=<jobId>` only to a legacy bare origin. */
export function jobOpenUrl(rawUrl: string | undefined, jobId: string): string | undefined {
  const safe = httpsUrl(rawUrl);
  const trimmedId = jobId.trim();
  if (!safe || !trimmedId) return safe;
  // `httpsUrl` parsed this address already, so a stored deep link simply keeps its own route.
  const parsed = new URL(safe);
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return safe;
  parsed.searchParams.set("job", trimmedId);
  return parsed.toString();
}
