import type { HistoryToolStep, MessageBlock, ToolHistory, ToolStepCall } from "@rakazo/contracts";

export type LiveStepTiming = {
  startedAtMs?: number;
  attempt?: number;
  forkedFromStep?: number;
};

export type LiveMessageUpdate =
  | { type: "progress"; payload: Record<string, unknown> | undefined }
  | ({
      type: "tool";
      name: string;
      detail?: string;
      skills?: string[];
      runSkills?: string[];
    } & LiveStepTiming)
  | {
      type: "tool_completed";
      name: string;
      durationMs: number;
      outcome?: string;
      detail?: string;
      skills?: string[];
    }
  | { type: "usage"; costUsd: number }
  | {
      type: "checkpoint";
      steps: ToolStep[];
      attempts?: number;
      costUsd?: number;
      modelId?: string;
      modelProvider?: string;
      skills?: string[];
    }
  | { type: "thinking"; segment: number; durationMs: number; lines: string[] };

/** Trims and deduplicates skill names case-insensitively while preserving first-seen casing. */
export function mergeSkillNames(...lists: readonly (readonly string[] | undefined)[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    if (!list) continue;
    for (const raw of list) {
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(trimmed);
    }
  }
  return merged;
}

export type ToolStepOutcome = "succeeded" | "failed" | "stopped";
export type ToolStep = Extract<MessageBlock, { kind: "steps" }>["steps"][number];

/** Calls a reply keeps arguments and results for; a later turn replays no more than these. */
export const TOOL_STEP_CALLS_KEPT = 40;

const SENTENCE_END_RE = /[.!?]["'”’)\]]*\s*$/;

/** True once `text` ends at a sentence boundary (or is empty) — safe to flush without cutting a clause. */
export function endsSentence(text: string): boolean {
  return text.trim() === "" || SENTENCE_END_RE.test(text);
}

export function appendTextSegment(segments: readonly MessageBlock[], text: string): MessageBlock[] {
  if (!text) return [...segments];
  const last = segments.at(-1);
  if (last?.kind === "text") {
    return [...segments.slice(0, -1), { kind: "text", text: last.text + text }];
  }
  return [...segments, { kind: "text", text }];
}

export function humanizeToolName(name: string): string {
  const spaced = name.replace(/_/g, " ").trim();
  if (!spaced) return name;
  const lower = spaced.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function progressMessageText(
  payload: Record<string, unknown> | undefined,
  previousText = "",
): string {
  return typeof payload?.delta === "string"
    ? previousText + payload.delta
    : String(payload?.text ?? "");
}

/** A live reasoning snapshot from its event payload, tolerant of a partial producer. */
export function thinkingLiveUpdate(
  payload: Record<string, unknown> | undefined,
): Extract<LiveMessageUpdate, { type: "thinking" }> {
  const count = (value: unknown) => {
    const number = Math.trunc(Number(value ?? 0));
    return Number.isFinite(number) && number > 0 ? number : 0;
  };
  return {
    type: "thinking",
    segment: count(payload?.segment),
    durationMs: count(payload?.durationMs),
    lines: Array.isArray(payload?.lines)
      ? payload.lines.filter((line): line is string => typeof line === "string")
      : [],
  };
}

export function reduceLiveMessageBlocks(
  current: readonly MessageBlock[],
  update: LiveMessageUpdate,
): MessageBlock[] {
  if (update.type === "thinking") return upsertThinkingBlock(current, update);
  if (update.type === "tool_completed") return completeLiveToolStep(current, update);
  if (update.type === "usage") return stampLiveStepsCost(current, update.costUsd);
  if (update.type === "checkpoint") return applyLiveCheckpoint(current, update);
  // A reset drops the text streamed so far (it will not be in the reply) and keeps the steps,
  // including tools still waiting on that text to finish its sentence.
  let blocks = current;
  if (update.type === "progress" && update.payload?.reset === true) {
    const waiting = current.at(-1)?.kind === "progress" ? current.at(-1) : undefined;
    blocks = current.filter((block) => block.kind !== "text" && block.kind !== "progress");
    const waitingNames = waiting?.kind === "progress" ? (waiting.pendingToolNames ?? []) : [];
    const waitingDetails = waiting?.kind === "progress" ? (waiting.pendingToolDetails ?? []) : [];
    const waitingSkills = waiting?.kind === "progress" ? (waiting.pendingToolSkills ?? []) : [];
    const waitingTimings = waiting?.kind === "progress" ? (waiting.pendingToolTimings ?? []) : [];
    for (let index = 0; index < waitingNames.length; index += 1) {
      blocks = appendToolCallSegment(
        blocks,
        waitingNames[index]!,
        waitingDetails[index] ?? undefined,
        waitingTimings[index] ?? undefined,
        waitingSkills[index] ?? undefined,
      );
    }
  }
  const tail = blocks.at(-1);
  const segments = tail?.kind === "progress" ? blocks.slice(0, -1) : blocks;
  const priorText = liveMessageText(blocks);
  const flushedLength =
    tail?.kind === "progress" ? priorText.length - tail.text.length : priorText.length;
  const tailText =
    update.type === "progress"
      ? progressMessageText(update.payload, priorText).slice(flushedLength)
      : tail?.kind === "progress"
        ? tail.text
        : "";
  const priorPendingNames = tail?.kind === "progress" ? (tail.pendingToolNames ?? []) : [];
  const priorPendingDetails =
    tail?.kind === "progress"
      ? priorPendingNames.map((_, index) => tail.pendingToolDetails?.[index] ?? null)
      : [];
  const priorPendingSkills =
    tail?.kind === "progress"
      ? priorPendingNames.map((_, index) => tail.pendingToolSkills?.[index] ?? null)
      : [];
  const priorPendingTimings =
    tail?.kind === "progress"
      ? priorPendingNames.map((_, index) => tail.pendingToolTimings?.[index] ?? null)
      : [];
  const toolTiming =
    update.type === "tool" && hasStepTiming(update)
      ? {
          ...(update.startedAtMs !== undefined ? { startedAtMs: update.startedAtMs } : {}),
          ...(update.attempt !== undefined ? { attempt: update.attempt } : {}),
          ...(update.forkedFromStep !== undefined ? { forkedFromStep: update.forkedFromStep } : {}),
        }
      : null;
  const normalizedUpdateSkills = update.type === "tool" ? mergeSkillNames(update.skills) : [];
  const pendingToolNames = [...priorPendingNames, ...(update.type === "tool" ? [update.name] : [])];
  const pendingToolDetails = [
    ...priorPendingDetails,
    ...(update.type === "tool" ? [update.detail?.trim() || null] : []),
  ];
  const pendingToolSkills = [
    ...priorPendingSkills,
    ...(update.type === "tool"
      ? [normalizedUpdateSkills.length > 0 ? normalizedUpdateSkills : null]
      : []),
  ];
  const pendingToolTimings = [
    ...priorPendingTimings,
    ...(update.type === "tool" ? [toolTiming] : []),
  ];
  const activity =
    update.type === "progress"
      ? update.payload?.activity === true
      : tail?.kind === "progress" && tail.activity === true;

  if (pendingToolNames.length > 0 && endsSentence(tailText)) {
    let next = activity ? [...segments] : appendTextSegment(segments, tailText);
    const runSkills = update.type === "tool" ? update.runSkills : undefined;
    for (let index = 0; index < pendingToolNames.length; index += 1) {
      next = appendToolCallSegment(
        next,
        pendingToolNames[index]!,
        pendingToolDetails[index] ?? undefined,
        pendingToolTimings[index] ?? undefined,
        pendingToolSkills[index] ?? undefined,
        index === 0 ? runSkills : undefined,
      );
    }
    return next;
  }
  if (!tailText) return [...segments];
  return [
    ...segments,
    {
      kind: "progress",
      text: tailText,
      ...(activity ? { activity: true as const } : {}),
      ...(pendingToolNames.length > 0 ? { pendingToolNames } : {}),
      ...(pendingToolDetails.some(Boolean) ? { pendingToolDetails } : {}),
      ...(pendingToolSkills.some(Boolean) ? { pendingToolSkills } : {}),
      ...(pendingToolTimings.some(Boolean) ? { pendingToolTimings } : {}),
    },
  ];
}

function upsertThinkingBlock(
  current: readonly MessageBlock[],
  update: Extract<LiveMessageUpdate, { type: "thinking" }>,
): MessageBlock[] {
  const block: MessageBlock = {
    kind: "thinking",
    durationMs: update.durationMs,
    lines: update.lines,
  };
  let ordinal = -1;
  let replaced = false;
  const next = current.map((existing) => {
    if (existing.kind !== "thinking") return existing;
    ordinal += 1;
    if (ordinal !== update.segment) return existing;
    replaced = true;
    return block;
  });
  return replaced ? next : [...current, block];
}

function liveMessageText(blocks: readonly MessageBlock[]): string {
  return blocks
    .filter((block) => block.kind === "text" || block.kind === "progress")
    .map((block) => block.text)
    .join("");
}

/**
 * Records how each call ended on the step it shows as. `calls` lists every step a call made, in
 * call order (a connector call can make several). If they stop lining up with the steps, the
 * steps are returned as they were rather than credited to the wrong step.
 */
export function withToolStepOutcomes(
  segments: readonly MessageBlock[],
  calls: readonly {
    label: string;
    outcome: ToolStepOutcome | undefined;
    tool?: string;
    call?: ToolStepCall;
    detail?: string;
    skills?: readonly string[];
    durationMs?: number;
    startedAtMs?: number;
  }[],
  runSkills?: readonly string[],
): MessageBlock[] {
  let next = 0;
  const annotated: MessageBlock[] = [];
  for (const block of segments) {
    if (block.kind !== "steps") {
      annotated.push(block);
      continue;
    }
    const activeAttempt = block.steps.reduce(
      (max, step) => Math.max(max, step.attempt ?? 1),
      block.attempts ?? 1,
    );
    const hasBranchHistory = block.steps.some(
      (step) => step.attempt !== undefined && step.attempt < activeAttempt,
    );
    const steps: HistoryToolStep[] = [];
    for (const step of block.steps as HistoryToolStep[]) {
      if (hasBranchHistory && step.attempt !== undefined && step.attempt < activeAttempt) {
        steps.push({ ...step });
        continue;
      }
      const outcomes: NonNullable<ToolStep["outcomes"]> = {};
      const own = calls.slice(next, next + step.count);
      next += step.count;
      if (own.length < step.count || own.some((call) => call.label !== step.label))
        return [...segments];
      for (const call of own)
        if (call.outcome) outcomes[call.outcome] = (outcomes[call.outcome] ?? 0) + 1;
      const { outcomes: _previous, tool: _tool, calls: _calls, ...rest } = step;
      const tool = own[0]?.tool;
      const kept = own.flatMap((call) => (call.call ? [call.call] : []));
      const replayable =
        tool !== undefined &&
        next <= TOOL_STEP_CALLS_KEPT &&
        kept.length === step.count &&
        own.every((call) => call.tool === tool);
      const hasCallDuration = own.some((call) => typeof call.durationMs === "number");
      const summedDuration = hasCallDuration
        ? own.reduce(
            (sum, call) =>
              sum +
              (typeof call.durationMs === "number" ? Math.max(0, Math.trunc(call.durationMs)) : 0),
            0,
          )
        : undefined;
      const startedAtMs =
        step.startedAtMs ?? own.find((call) => typeof call.startedAtMs === "number")?.startedAtMs;
      const hasTiming =
        step.status !== undefined ||
        hasCallDuration ||
        startedAtMs !== undefined ||
        step.durationMs !== undefined;
      const nextStatus: ToolStep["status"] = hasTiming
        ? outcomes.failed && !outcomes.succeeded
          ? "failed"
          : outcomes.stopped && !outcomes.succeeded && !outcomes.failed
            ? "stopped"
            : "done"
        : undefined;
      const resolvedDetail = own.findLast((call) => call.detail?.trim())?.detail?.trim();
      const resolvedSkills = mergeSkillNames(step.skills, ...own.map((call) => call.skills));
      steps.push({
        ...rest,
        ...(resolvedDetail ? { detail: resolvedDetail } : {}),
        ...(resolvedSkills.length > 0 ? { skills: resolvedSkills } : {}),
        ...(startedAtMs !== undefined ? { startedAtMs } : {}),
        ...(summedDuration !== undefined
          ? { durationMs: summedDuration }
          : step.durationMs !== undefined
            ? { durationMs: step.durationMs }
            : {}),
        ...(nextStatus !== undefined ? { status: nextStatus } : {}),
        ...(replayable ? { tool, calls: kept } : {}),
        ...(Object.keys(outcomes).length > 0 ? { outcomes } : {}),
      });
    }
    const blockSkills = mergeSkillNames(
      block.skills,
      runSkills,
      ...steps.map((step) => step.skills),
    );
    annotated.push({
      ...block,
      steps,
      ...(blockSkills.length > 0 ? { skills: blockSkills } : {}),
    });
  }
  return annotated;
}

/** Splits a reply's kept tool calls off its blocks for client display, leaving toolHistory on the DB row. */
export function splitToolHistory(blocks: readonly MessageBlock[]): {
  blocks: MessageBlock[];
  toolHistory: ToolHistory | undefined;
} {
  const steps: ToolHistory["steps"] = [];
  const shown = blocks.map((block): MessageBlock => {
    if (block.kind !== "steps") return block;
    return {
      ...block,
      steps: (block.steps as HistoryToolStep[]).map(({ tool, calls, ...step }) => {
        steps.push(tool && calls?.length ? { tool, calls } : null);
        return step;
      }),
    };
  });
  return { blocks: shown, toolHistory: steps.some(Boolean) ? { steps } : undefined };
}

/** Reattaches stored toolHistory entries onto steps blocks for replay. */
export function withToolHistory(
  blocks: readonly MessageBlock[],
  history: ToolHistory | undefined,
): MessageBlock[] {
  if (!history) return [...blocks];
  let index = 0;
  return blocks.map((block) =>
    block.kind === "steps"
      ? {
          ...block,
          steps: block.steps.map((step): HistoryToolStep => {
            const kept = history.steps[index++];
            return kept ? { ...step, tool: kept.tool, calls: kept.calls } : step;
          }),
        }
      : block,
  );
}

export function appendToolStep(
  steps: readonly ToolStep[],
  toolName: string,
  detail?: string,
  timing?: LiveStepTiming,
  skills?: readonly string[],
): ToolStep[] {
  const label = humanizeToolName(toolName);
  const normalizedDetail = detail?.trim() || undefined;
  const normalizedSkills = mergeSkillNames(skills);
  const timed = timing !== undefined && hasStepTiming(timing);
  const prepared = timed
    ? steps.map((step) =>
        step.status === "running"
          ? {
              ...step,
              status: "done" as const,
              ...(step.durationMs === undefined &&
              step.startedAtMs !== undefined &&
              timing.startedAtMs !== undefined
                ? { durationMs: Math.max(0, timing.startedAtMs - step.startedAtMs) }
                : {}),
            }
          : step,
      )
    : steps;
  const last = prepared.at(-1);
  if (
    last &&
    last.label === label &&
    (last.detail ?? undefined) === normalizedDetail &&
    (!timed ||
      (last.attempt === timing.attempt &&
        (last.forkedFromStep ?? undefined) === timing.forkedFromStep &&
        last.status !== "stopped" &&
        last.status !== "failed"))
  ) {
    const mergedSkills = mergeSkillNames(last.skills, normalizedSkills);
    return [
      ...prepared.slice(0, -1),
      {
        ...last,
        count: last.count + 1,
        ...(mergedSkills.length > 0 ? { skills: mergedSkills } : {}),
        ...(timed && timing.startedAtMs !== undefined ? { status: "running" as const } : {}),
      },
    ];
  }
  return [
    ...prepared,
    {
      label,
      count: 1,
      ...(normalizedDetail ? { detail: normalizedDetail } : {}),
      ...(normalizedSkills.length > 0 ? { skills: normalizedSkills } : {}),
      ...(timed && timing.startedAtMs !== undefined
        ? { startedAtMs: timing.startedAtMs, status: "running" as const }
        : {}),
      ...(timed && timing.attempt !== undefined ? { attempt: timing.attempt } : {}),
      ...(timed && timing.forkedFromStep !== undefined
        ? { forkedFromStep: timing.forkedFromStep }
        : {}),
    },
  ];
}

/** Puts a note on the newest step, splitting it off a run of the same step so it stays in order. */
export function noteLastToolStep(segments: readonly MessageBlock[], note: string): MessageBlock[] {
  const index = segments.findLastIndex((block) => block.kind === "steps");
  const block = segments[index];
  const last = block?.kind === "steps" ? block.steps.at(-1) : undefined;
  if (block?.kind !== "steps" || !last) return [...segments];
  const steps = block.steps.slice(0, -1);
  if (last.count > 1)
    steps.push(
      { ...last, count: last.count - 1 },
      { label: last.label, count: 1, ...(last.detail ? { detail: last.detail } : {}), note },
    );
  else steps.push({ ...last, note: last.note ? `${last.note}\n\n${note}` : note });
  const next = [...segments];
  next[index] = { ...block, steps };
  return next;
}

/** Removes the newest `count` notes from the steps. */
export function withoutLastToolStepNotes(
  segments: readonly MessageBlock[],
  count: number,
): MessageBlock[] {
  let left = count;
  const next = [...segments];
  for (let index = next.length - 1; index >= 0 && left > 0; index -= 1) {
    const block = next[index];
    if (block?.kind !== "steps") continue;
    const steps = [...block.steps];
    for (let step = steps.length - 1; step >= 0 && left > 0; step -= 1) {
      const { note, ...rest } = steps[step]!;
      if (note === undefined) continue;
      steps[step] = rest;
      left -= 1;
    }
    next[index] = { ...block, steps };
  }
  return next;
}

export function appendToolCallSegment(
  segments: readonly MessageBlock[],
  toolName: string,
  detail?: string,
  timing?: LiveStepTiming,
  skills?: readonly string[],
  runSkills?: readonly string[],
): MessageBlock[] {
  const last = segments.at(-1);
  const priorSteps = last?.kind === "steps" ? last.steps : [];
  const steps = appendToolStep(priorSteps, toolName, detail, timing, skills);
  const blockSkills = mergeSkillNames(
    last?.kind === "steps" ? last.skills : undefined,
    runSkills,
    skills,
  );
  if (last?.kind === "steps") {
    const nextAttempts =
      timing?.attempt !== undefined ? Math.max(last.attempts ?? 1, timing.attempt) : last.attempts;
    return [
      ...segments.slice(0, -1),
      {
        ...last,
        steps,
        ...(nextAttempts !== undefined ? { attempts: nextAttempts } : {}),
        ...(blockSkills.length > 0 ? { skills: blockSkills } : {}),
      },
    ];
  }
  return [
    ...segments,
    {
      kind: "steps",
      steps,
      ...(timing?.attempt !== undefined && timing.attempt > 1 ? { attempts: timing.attempt } : {}),
      ...(blockSkills.length > 0 ? { skills: blockSkills } : {}),
    },
  ];
}

export function hasStepTiming(timing: LiveStepTiming | undefined): timing is LiveStepTiming {
  return Boolean(
    timing &&
      (timing.startedAtMs !== undefined ||
        timing.attempt !== undefined ||
        timing.forkedFromStep !== undefined),
  );
}

export function validNonNegInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
}

export function validPosInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

export function validNonNegNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

export function validStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = mergeSkillNames(
    value.filter((item): item is string => typeof item === "string"),
  );
  return normalized.length > 0 ? normalized : undefined;
}

export function hasRunningStep(blocks: readonly MessageBlock[]): boolean {
  return blocks.some(
    (block) => block.kind === "steps" && block.steps.some((step) => step.status === "running"),
  );
}

export function currentLiveCostUsd(blocks: readonly MessageBlock[]): number | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.kind === "steps" && block.costUsd !== undefined) return block.costUsd;
  }
  return undefined;
}

function completeLiveToolStep(
  current: readonly MessageBlock[],
  update: Extract<LiveMessageUpdate, { type: "tool_completed" }>,
): MessageBlock[] {
  const blockIndex = current.findLastIndex((block) => block.kind === "steps");
  if (blockIndex === -1) return [...current];
  const block = current[blockIndex];
  if (block?.kind !== "steps") return [...current];
  const label = humanizeToolName(update.name);
  let stepIndex = block.steps.findLastIndex(
    (step) => step.label === label && (step.status === "running" || step.durationMs === undefined),
  );
  if (stepIndex === -1) stepIndex = block.steps.findLastIndex((step) => step.label === label);
  if (stepIndex === -1) stepIndex = block.steps.findLastIndex((step) => step.status === "running");
  if (stepIndex === -1) return [...current];
  const target = block.steps[stepIndex]!;
  const added = Math.max(0, Math.trunc(update.durationMs));
  const durationMs =
    target.durationMs !== undefined && target.count > 1 ? target.durationMs + added : added;
  const status: ToolStep["status"] =
    update.outcome === "failed" || update.outcome === "error"
      ? "failed"
      : update.outcome === "stopped" || update.outcome === "cancelled"
        ? "stopped"
        : "done";
  const completedDetail = update.detail?.trim() || undefined;
  const completedSkills = mergeSkillNames(update.skills);
  const steps = block.steps.map((step, index) => {
    if (index !== stepIndex) return step;
    const mergedSkills = mergeSkillNames(step.skills, completedSkills);
    return {
      ...step,
      durationMs,
      status,
      ...(completedDetail ? { detail: completedDetail } : {}),
      ...(mergedSkills.length > 0 ? { skills: mergedSkills } : {}),
    };
  });
  const blockSkills = mergeSkillNames(block.skills, completedSkills);
  const next = [...current];
  next[blockIndex] = {
    ...block,
    steps,
    ...(blockSkills.length > 0 ? { skills: blockSkills } : {}),
  };
  return next;
}

function stampLiveStepsCost(current: readonly MessageBlock[], costUsd: number): MessageBlock[] {
  const blockIndex = current.findLastIndex((block) => block.kind === "steps");
  if (blockIndex === -1) return [...current];
  const block = current[blockIndex];
  if (block?.kind !== "steps") return [...current];
  const next = [...current];
  next[blockIndex] = { ...block, costUsd };
  return next;
}

function applyLiveCheckpoint(
  current: readonly MessageBlock[],
  update: Extract<LiveMessageUpdate, { type: "checkpoint" }>,
): MessageBlock[] {
  const existingIndex = current.findLastIndex((block) => block.kind === "steps");
  const existing = existingIndex !== -1 ? current[existingIndex] : undefined;
  const mergedSkills = mergeSkillNames(
    existing?.kind === "steps" ? existing.skills : undefined,
    update.skills,
    ...update.steps.map((step) => step.skills),
  );
  const checkpointBlock: Extract<MessageBlock, { kind: "steps" }> = {
    kind: "steps",
    steps: update.steps,
    ...(update.attempts !== undefined ? { attempts: update.attempts } : {}),
    ...(update.costUsd !== undefined ? { costUsd: update.costUsd } : {}),
    ...(update.modelId ? { modelId: update.modelId } : {}),
    ...(update.modelProvider ? { modelProvider: update.modelProvider } : {}),
    ...(mergedSkills.length > 0 ? { skills: mergedSkills } : {}),
  };
  if (existingIndex !== -1 && existing?.kind === "steps") {
    const next = [...current];
    next[existingIndex] = { ...existing, ...checkpointBlock };
    return next;
  }
  const tail = current.at(-1);
  if (tail?.kind === "progress") {
    return [...current.slice(0, -1), checkpointBlock, tail];
  }
  return [...current, checkpointBlock];
}
