import type { MessageBlock } from "@rakazo/contracts";

export type ToolStep = Extract<MessageBlock, { kind: "steps" }>["steps"][number];

export type StepCategory =
  | "terminal"
  | "files"
  | "search"
  | "git"
  | "docs"
  | "web"
  | "mail"
  | "chat"
  | "computer"
  | "tool";

export type StepVisualState = "running" | "done" | "failed" | "stopped" | "waiting";

export interface CheckpointNode {
  index: number;
  step: ToolStep;
  attempt: number;
  lane: number;
  state: StepVisualState;
  isAbandonedBranch: boolean;
  isBranchRoot: boolean;
  forkFromIndex?: number;
  attemptBadge?: number;
  durationMs?: number;
  startedOffsetMs?: number;
  sharePercent: number;
  segmentWeight: number;
}

export interface CheckpointGraph {
  nodes: CheckpointNode[];
  activeAttempt: number;
  totalAttempts: number;
  maxLane: number;
  hasBranching: boolean;
  totalDurationMs: number;
  completedCount: number;
  totalCount: number;
}

export interface BuildCheckpointGraphOptions {
  runStartedAtMs?: number;
  runAttempts?: number;
  runStatus?: string;
  nowMs?: number;
}

/** Maps a humanized step label and detail into a generic UI icon category without vendor rules. */
export function stepCategory(label: string, detail?: string): StepCategory {
  const normalized = label.trim().toLowerCase().replace(/\s+/g, " ");
  const normalizedDetail = detail?.trim().toLowerCase() ?? "";

  if (
    /\b(browser|web fetch|fetch|open url|navigate)\b/.test(normalized) ||
    /^https?:\/\//.test(normalizedDetail)
  ) {
    if (!/\b(read|write|edit|list|shell|bash|terminal)\b/.test(normalized)) {
      return /\bcomputer\b/.test(normalized) ? "computer" : "web";
    }
  }
  if (/\b(computer|screen|desktop|screenshot|observe)\b/.test(normalized)) {
    return "computer";
  }
  if (/\b(draft|drafted|notes|note|doc|document|markdown|page|summary|skill)\b/.test(normalized)) {
    return "docs";
  }
  if (
    /\b(shell|bash|terminal|run command|execute|build|built|compile|test)\b/.test(normalized) ||
    /^(npm|pnpm|yarn|bun|node|python|pytest|cargo|gh|git)\b/.test(normalizedDetail)
  ) {
    if (/\b(commit|commits|release|branch|pull request|diff|repo|tag)\b/.test(normalized)) {
      return "git";
    }
    return "terminal";
  }
  if (
    /\b(commit|commits|branch|diff|merge|pull request|release|repository|repo|git|tag)\b/.test(
      normalized,
    )
  ) {
    return "git";
  }
  if (
    /\b(read file|write file|edit|apply patch|list files|attach file|open path|save page|file|files)\b/.test(
      normalized,
    )
  ) {
    return "files";
  }
  if (/\b(search|find|grep|glob|query|lookup|issues|collect|collected)\b/.test(normalized)) {
    return "search";
  }
  if (/\b(email|mail|inbox)\b/.test(normalized)) {
    return "mail";
  }
  if (/\b(message|chat|reply|thread|channel|post|tweet)\b/.test(normalized)) {
    return "chat";
  }
  return "tool";
}

/** Formats wall-clock elapsed milliseconds as m:ss (or h:mm:ss). */
export function formatClockDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return "0:00";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Formats a single step duration cleanly (e.g. 2.3s or 450ms). */
export function formatStepDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 100) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Formats USD cost compactly without losing sub-cent precision. */
export function formatCostUsd(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd) || usd < 0) return "";
  if (usd === 0) return "$0.00";
  if (usd < 0.001) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** Generically humanizes a model identifier (stripping provider prefix & date suffixes) without vendor checks. */
export function formatModelTitle(modelId: string | null | undefined, fallback: string): string {
  const raw = modelId?.trim();
  if (!raw) return fallback;
  const tail = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  const cleaned = tail.replace(/-(?:\d{8}|latest)$/i, "");
  const parts = cleaned.split(/[-_\s]+/).filter(Boolean);
  if (parts.length === 0) return fallback;

  const formatted: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const next = parts[index + 1];
    if (/^\d{1,2}$/.test(part) && next && /^\d{1,2}$/.test(next)) {
      formatted.push(`${part}.${next}`);
      index += 1;
      continue;
    }
    if (/^\d/.test(part) || /\./.test(part)) {
      formatted.push(part);
      continue;
    }
    formatted.push(part.charAt(0).toUpperCase() + part.slice(1));
  }
  return formatted.join(" ");
}

function resolveStepState(
  step: ToolStep,
  isLast: boolean,
  waitingForInput: boolean,
  isRunLive: boolean,
): StepVisualState {
  if (step.status === "stopped") return "stopped";
  if (step.status === "failed") return "failed";
  if (step.outcomes?.failed && !step.outcomes.succeeded) return "failed";
  if (step.outcomes?.stopped && !step.outcomes.succeeded && !step.outcomes.failed) return "stopped";
  if (step.status === "running") {
    if (waitingForInput && isLast) return "waiting";
    if (isRunLive) return "running";
    return "done";
  }
  if (step.status === "done") return "done";
  if (waitingForInput && isLast) return "waiting";
  return "done";
}

/** Computes lane topology, fork edges, timings, and segment proportions for Monitor + Checkpoints. */
export function buildCheckpointGraph(
  steps: readonly ToolStep[],
  options: BuildCheckpointGraphOptions = {},
): CheckpointGraph {
  if (steps.length === 0) {
    return {
      nodes: [],
      activeAttempt: Math.max(1, options.runAttempts ?? 1),
      totalAttempts: Math.max(1, options.runAttempts ?? 1),
      maxLane: 0,
      hasBranching: (options.runAttempts ?? 1) > 1,
      totalDurationMs: 0,
      completedCount: 0,
      totalCount: 0,
    };
  }

  let activeAttempt = Math.max(1, options.runAttempts ?? 1);
  for (const step of steps) {
    if (step.attempt !== undefined && step.attempt > activeAttempt) {
      activeAttempt = step.attempt;
    }
  }

  const waitingForInput = options.runStatus === "waiting_input";
  const isRunLive = options.runStatus === "running" || options.runStatus === "leased";
  const states = steps.map((step, index) =>
    resolveStepState(step, index === steps.length - 1, waitingForInput, isRunLive),
  );

  // Identify abandoned retry branches (earlier attempts containing stopped/failed tail steps or superseded before activeAttempt).
  const firstBranchCut = steps.findIndex(
    (step, index) =>
      (step.attempt ?? 1) < activeAttempt &&
      (states[index] === "stopped" || states[index] === "failed"),
  );
  const abandonedAttempts: number[] = [];
  for (let index = 0; index < steps.length; index += 1) {
    const attempt = steps[index]?.attempt ?? 1;
    const abandoned =
      attempt < activeAttempt &&
      (states[index] === "stopped" ||
        states[index] === "failed" ||
        (firstBranchCut !== -1 && index >= firstBranchCut));
    if (abandoned && !abandonedAttempts.includes(attempt)) {
      abandonedAttempts.push(attempt);
    }
  }

  const laneByAttempt = new Map<number, number>();
  abandonedAttempts.forEach((attempt, pos) => {
    laneByAttempt.set(attempt, pos + 1);
  });

  const nowMs = options.nowMs;
  const durations = steps.map((step, index) => {
    if (typeof step.durationMs === "number" && Number.isFinite(step.durationMs)) {
      return Math.max(0, step.durationMs);
    }
    if (
      states[index] === "running" &&
      step.startedAtMs !== undefined &&
      nowMs !== undefined &&
      nowMs >= step.startedAtMs
    ) {
      return Math.max(0, nowMs - step.startedAtMs);
    }
    return undefined;
  });

  const baselineStart =
    options.runStartedAtMs ?? steps.find((step) => step.startedAtMs !== undefined)?.startedAtMs;

  const knownDurationSum = durations.reduce<number>((sum, dur) => sum + (dur ?? 0), 0);
  const fallbackWeight = knownDurationSum > 0 ? knownDurationSum / steps.length : 1;

  const seenAttemptBadge = new Set<number>();
  const nodes: CheckpointNode[] = [];
  let maxLane = 0;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    const state = states[index]!;
    const attempt = step.attempt ?? 1;
    const isAbandonedBranch =
      attempt < activeAttempt &&
      (state === "stopped" ||
        state === "failed" ||
        (firstBranchCut !== -1 && index >= firstBranchCut));
    const lane = isAbandonedBranch ? (laneByAttempt.get(attempt) ?? 1) : 0;
    if (lane > maxLane) maxLane = lane;

    const prevSameLane = nodes.findLast((node) => node.lane === lane);
    const isBranchRoot =
      (isAbandonedBranch && !prevSameLane) ||
      step.forkedFromStep !== undefined ||
      (attempt > 1 && !isAbandonedBranch && !seenAttemptBadge.has(attempt));

    let forkFromIndex: number | undefined;
    if (step.forkedFromStep !== undefined) {
      forkFromIndex = Math.max(0, Math.min(index - 1, step.forkedFromStep));
    } else if (isAbandonedBranch && !prevSameLane) {
      forkFromIndex = nodes.findLast((node) => node.lane === 0)?.index;
    } else if (!isAbandonedBranch && attempt > 1 && isBranchRoot) {
      forkFromIndex = nodes.findLast((node) => node.lane === 0)?.index;
    }

    let attemptBadge: number | undefined;
    if (attempt > 1 && !seenAttemptBadge.has(attempt)) {
      seenAttemptBadge.add(attempt);
      attemptBadge = attempt;
    }

    const durationMs = durations[index];
    const startedOffsetMs =
      step.startedAtMs !== undefined &&
      baselineStart !== undefined &&
      step.startedAtMs >= baselineStart
        ? step.startedAtMs - baselineStart
        : undefined;

    const sharePercent =
      durationMs !== undefined && knownDurationSum > 0
        ? Math.round((durationMs / knownDurationSum) * 100)
        : Math.round(100 / steps.length);

    const rawWeight = durationMs !== undefined && durationMs > 0 ? durationMs : fallbackWeight;
    const avgWeight = knownDurationSum > 0 ? knownDurationSum / steps.length : 1;
    const segmentWeight = Math.min(4, Math.max(0.5, rawWeight / Math.max(1, avgWeight)));

    nodes.push({
      index,
      step,
      attempt,
      lane,
      state,
      isAbandonedBranch,
      isBranchRoot,
      ...(forkFromIndex !== undefined ? { forkFromIndex } : {}),
      ...(attemptBadge !== undefined ? { attemptBadge } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(startedOffsetMs !== undefined ? { startedOffsetMs } : {}),
      sharePercent,
      segmentWeight,
    });
  }

  const totalDurationMs = durations.reduce<number>((sum, dur) => sum + (dur ?? 0), 0);
  const activeNodes = nodes.filter((node) => !node.isAbandonedBranch);
  const completedCount = activeNodes.filter((node) => node.state === "done").length;

  return {
    nodes,
    activeAttempt,
    totalAttempts: activeAttempt,
    maxLane,
    hasBranching: maxLane > 0 || activeAttempt > 1,
    totalDurationMs,
    completedCount,
    totalCount: activeNodes.length,
  };
}
