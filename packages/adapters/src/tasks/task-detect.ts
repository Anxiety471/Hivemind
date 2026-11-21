import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import type { TicketDecisionInput } from "@rakazo/contracts";
import { deadlineSignal } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { recordUsage, runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { resolveDeploymentModel } from "../models/deployment-model.js";
import type { TicketChangeNotifier } from "./ticket-changes.js";
import { createTicket, getTicket, listBoardTickets, updateTicket } from "./ticket-tools.js";

const TASK_DETECT_CONTEXT_TIMEOUT_MS = 1_500;
const TASK_DETECT_HTTP_TIMEOUT_MS = 10_000;
const TASK_DETECT_MODEL_TIMEOUT_MS = 60_000;

/** Conversational triggers that may create or advance Kanban tasks. */
export const TASK_DETECT_TRIGGERS: ReadonlySet<string> = new Set([
  "user",
  "messaging",
  "follow_up",
  "bot_message",
]);

export function taskDetectBaseUrl(): string | undefined {
  const raw = process.env.TASK_DETECT_URL?.trim();
  if (raw) {
    if (raw === "off" || raw === "false") return undefined;
    return raw.replace(/\/+$/, "");
  }
  const retryUrl = process.env.MODEL_RETRY_RULES_URL?.trim();
  if (!retryUrl) return undefined;
  try {
    return new URL(retryUrl).origin;
  } catch {
    return undefined;
  }
}

export function shouldEnqueueTaskDetect(input: {
  ticketBoardEnabled: boolean;
  trigger: string;
  sourceMessageId: string | null;
  runBotId: string;
  threadBotId: string | null;
  threadGroupId: string | null;
  nonOwnerChatRun: boolean;
}): boolean {
  return (
    input.ticketBoardEnabled &&
    !input.nonOwnerChatRun &&
    TASK_DETECT_TRIGGERS.has(input.trigger) &&
    Boolean(input.sourceMessageId) &&
    (input.threadBotId === input.runBotId || input.threadGroupId !== null)
  );
}

export type GoTaskContextResponse = {
  enabled: boolean;
  assignedContext?: string;
  referencedContext?: string;
};

type GoTaskPrepareResponse = {
  inspect: boolean;
  reason?: string;
  systemPrompt?: string;
  userPrompt?: string;
};

type GoTaskApplyResponse = {
  created: Array<{ id: string; ref: string; title: string; status: string; priority?: string }>;
  updated: Array<{ id: string; ref: string; title: string; status: string; priority?: string }>;
  skipped: number;
};

export type TaskSyncAction = {
  op: "create" | "update";
  ticketId?: string;
  ref?: string;
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  ownerUserId?: string | null;
  ownerBotId?: string | null;
  workerBotIds?: string[];
  decision?: TicketDecisionInput | null;
};

/**
 * Applies a batch of bot task actions through the Go backend (`/internal/task-detect/apply`),
 * falling back to local Prisma ticket tools when `TASK_DETECT_URL` is unset or unreachable.
 */
export async function syncTasksViaGoOrLocal(
  deps: { prisma: PrismaClient; onTicketChange?: TicketChangeNotifier },
  input: {
    runId: string;
    spaceId: string;
    userId: string;
    botId: string;
    actions: readonly TaskSyncAction[];
  },
): Promise<GoTaskApplyResponse | { error: string }> {
  const actions = input.actions.slice(0, 5);
  if (actions.length === 0) {
    return { error: "Provide at least one task action." };
  }
  const baseUrl = taskDetectBaseUrl();
  if (baseUrl) {
    try {
      return await postGoJson<GoTaskApplyResponse>(`${baseUrl}/internal/task-detect/apply`, {
        runId: input.runId,
        spaceId: input.spaceId,
        userId: input.userId,
        botId: input.botId,
        actions,
      });
    } catch (error) {
      getLogger().warn("task.detect apply unavailable, falling back locally", {
        "run.id": input.runId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const created: GoTaskApplyResponse["created"] = [];
  const updated: GoTaskApplyResponse["updated"] = [];
  let skipped = 0;

  const existingResult = await listBoardTickets(deps, {
    spaceId: input.spaceId,
    assigneeBotId: input.botId,
  });
  const openTickets = "tickets" in existingResult ? [...existingResult.tickets] : [];
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  for (const action of actions) {
    if (action.op === "create") {
      const title = action.title?.trim() ?? "";
      if (!title) {
        skipped += 1;
        continue;
      }
      const normalizedTitle = normalize(title);
      const duplicate = openTickets.find((item) => normalize(item.title) === normalizedTitle);
      if (duplicate) {
        const res = await updateTicket(deps, {
          spaceId: input.spaceId,
          botId: input.botId,
          userId: input.userId,
          id: duplicate.id,
          ...(action.status ? { status: action.status } : {}),
          ...(action.description !== undefined ? { description: action.description } : {}),
          ...(action.priority ? { priority: action.priority } : {}),
          ...(action.ownerUserId !== undefined ? { ownerUserId: action.ownerUserId } : {}),
          ...(action.ownerBotId !== undefined ? { ownerBotId: action.ownerBotId } : {}),
          ...(action.workerBotIds !== undefined ? { workerBotIds: action.workerBotIds } : {}),
          ...(action.decision !== undefined ? { decision: action.decision } : {}),
        });
        if (!("error" in res)) {
          updated.push({
            id: res.ticket.id,
            ref: res.ticket.ref,
            title: res.ticket.title,
            status: res.ticket.status,
            priority: res.ticket.priority,
          });
        } else {
          skipped += 1;
        }
        continue;
      }
      const res = await createTicket(deps, {
        spaceId: input.spaceId,
        botId: input.botId,
        userId: input.userId,
        title,
        ...(action.description !== undefined ? { description: action.description } : {}),
        ...(action.priority ? { priority: action.priority } : {}),
        ...(action.ownerUserId !== undefined ? { ownerUserId: action.ownerUserId } : {}),
        ...(action.ownerBotId !== undefined ? { ownerBotId: action.ownerBotId } : {}),
        ...(action.workerBotIds !== undefined ? { workerBotIds: action.workerBotIds } : {}),
        ...(action.decision !== undefined ? { decision: action.decision } : {}),
      });
      if (!("error" in res)) {
        let ticket = res.ticket;
        if (action.status && action.status !== ticket.status) {
          const moved = await updateTicket(deps, {
            spaceId: input.spaceId,
            botId: input.botId,
            userId: input.userId,
            id: ticket.id,
            status: action.status,
          });
          if (!("error" in moved)) ticket = moved.ticket;
        }
        openTickets.push(ticket);
        created.push({
          id: ticket.id,
          ref: ticket.ref,
          title: ticket.title,
          status: ticket.status,
          priority: ticket.priority,
        });
      } else {
        skipped += 1;
      }
      continue;
    }

    let targetId = action.ticketId?.trim() ?? "";
    if (!targetId && action.ref?.trim()) {
      const found = await getTicket(deps, { spaceId: input.spaceId, ref: action.ref.trim() });
      if (!("error" in found)) targetId = found.ticket.id;
    }
    if (!targetId) {
      skipped += 1;
      continue;
    }
    const res = await updateTicket(deps, {
      spaceId: input.spaceId,
      botId: input.botId,
      userId: input.userId,
      id: targetId,
      ...(action.title ? { title: action.title } : {}),
      ...(action.description !== undefined ? { description: action.description } : {}),
      ...(action.status ? { status: action.status } : {}),
      ...(action.priority ? { priority: action.priority } : {}),
      ...(action.ownerUserId !== undefined ? { ownerUserId: action.ownerUserId } : {}),
      ...(action.ownerBotId !== undefined ? { ownerBotId: action.ownerBotId } : {}),
      ...(action.workerBotIds !== undefined ? { workerBotIds: action.workerBotIds } : {}),
      ...(action.decision !== undefined ? { decision: action.decision } : {}),
    });
    if (!("error" in res)) {
      updated.push({
        id: res.ticket.id,
        ref: res.ticket.ref,
        title: res.ticket.title,
        status: res.ticket.status,
        priority: res.ticket.priority,
      });
    } else {
      skipped += 1;
    }
  }

  return { created, updated, skipped };
}

/**
 * Fetches prompt-ready assigned and referenced Kanban ticket blocks from the Go backend.
 * Returns undefined when TASK_DETECT_URL is unset or the Go service cannot answer in time.
 */
export async function loadGoTaskDetectContext(input: {
  spaceId: string;
  userId: string;
  botId: string;
  promptText: string;
  maxBytes?: number;
  signal?: AbortSignal;
}): Promise<GoTaskContextResponse | undefined> {
  const baseUrl = taskDetectBaseUrl();
  if (!baseUrl) return undefined;
  try {
    const response = await fetch(`${baseUrl}/internal/task-detect/context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spaceId: input.spaceId,
        userId: input.userId,
        botId: input.botId,
        promptText: input.promptText,
        ...(input.maxBytes ? { maxBytes: input.maxBytes } : {}),
      }),
      signal: deadlineSignal(TASK_DETECT_CONTEXT_TIMEOUT_MS, input.signal),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = (await response.json()) as Partial<GoTaskContextResponse> | null;
    if (!parsed || typeof parsed.enabled !== "boolean") {
      throw new Error("Invalid task-detect context response");
    }
    return {
      enabled: parsed.enabled,
      assignedContext:
        typeof parsed.assignedContext === "string" ? parsed.assignedContext : undefined,
      referencedContext:
        typeof parsed.referencedContext === "string" ? parsed.referencedContext : undefined,
    };
  } catch (error) {
    getLogger().warn("task.detect context unavailable, falling back locally", {
      "space.id": input.spaceId,
      "bot.id": input.botId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export type DetectRunTasksDeps = {
  prisma: PrismaClient;
  runtime: AgentRuntime;
  deploymentModelKey?: string;
  deploymentModelConfigured?: boolean;
  resolveModel?: (input: {
    userId: string;
    spaceId: string;
    botId: string;
  }) => Promise<AgentRunRequest["model"]>;
};

/**
 * Post-turn Kanban task detection hook.
 *
 * The Go backend (`apps/api-go/internal/taskdetect`) owns eligibility checks,
 * transcript/prompt building, strict JSON parsing, deduplication, Postgres ticket
 * writes, and realtime Kanban broadcasts. This worker step bridges the run's
 * configured provider-neutral LLM runtime to the Go prepare/apply endpoints.
 */
export async function detectRunTasks(
  deps: DetectRunTasksDeps,
  runId: string,
  answeredMessageIds: readonly string[] = [],
): Promise<GoTaskApplyResponse | undefined> {
  const baseUrl = taskDetectBaseUrl();
  if (!baseUrl) return undefined;

  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    select: { id: true, spaceId: true, userId: true, botId: true, threadId: true },
  });
  if (!run) return undefined;

  const prepared = await postGoJson<GoTaskPrepareResponse>(
    `${baseUrl}/internal/task-detect/prepare`,
    {
      runId: run.id,
      spaceId: run.spaceId,
      userId: run.userId,
      botId: run.botId,
      ...(answeredMessageIds.length ? { answeredMessageIds } : {}),
    },
  );
  if (!prepared.inspect || !prepared.systemPrompt || !prepared.userPrompt) {
    return undefined;
  }

  const model = await resolveTaskDetectModel(deps, run);
  if (model.provider === "scripted") {
    return undefined;
  }

  const operationId = `task-detect:${run.id}`;
  let rawOutput = "";
  for await (const event of deps.runtime.run(
    {
      botId: run.botId,
      threadId: run.threadId,
      runId: operationId,
      usageOperationKind: "setup",
      onUsage: async (event) => {
        await recordUsage(deps.prisma, event, {
          spaceId: run.spaceId,
          botId: run.botId,
          userId: run.userId,
          runId: run.id,
          parentRunId: run.id,
          operationId,
          operationKind: "setup",
        });
      },
      prompt: prepared.userPrompt,
      instructions: prepared.systemPrompt,
      history: [],
      tools: [],
      model,
    },
    {
      operationId,
      traceId: operationId,
      spaceId: run.spaceId,
      userId: run.userId,
      botId: run.botId,
      runId: run.id,
      signal: deadlineSignal(TASK_DETECT_MODEL_TIMEOUT_MS),
    },
  )) {
    if (event.type === "done" && event.text) rawOutput = event.text;
    if (event.type === "usage" && !event.accounted) {
      await recordUsage(deps.prisma, event, {
        spaceId: run.spaceId,
        botId: run.botId,
        userId: run.userId,
        runId: run.id,
        parentRunId: run.id,
        operationId,
        operationKind: "setup",
      });
    }
  }

  if (!rawOutput.trim()) return undefined;

  return postGoJson<GoTaskApplyResponse>(`${baseUrl}/internal/task-detect/apply`, {
    runId: run.id,
    spaceId: run.spaceId,
    userId: run.userId,
    botId: run.botId,
    rawOutput,
  });
}

async function resolveTaskDetectModel(
  deps: DetectRunTasksDeps,
  run: { userId: string; spaceId: string; botId: string },
): Promise<AgentRunRequest["model"]> {
  if (deps.resolveModel) {
    return runAsTenant({ spaceId: run.spaceId, userId: run.userId }, () =>
      deps.resolveModel!({
        userId: run.userId,
        spaceId: run.spaceId,
        botId: run.botId,
      }),
    );
  }
  if (deps.deploymentModelConfigured) {
    const deploymentFallback = resolveDeploymentModel();
    return {
      provider: deploymentFallback.provider,
      id: deploymentFallback.model,
      apiKey: deps.deploymentModelKey,
    };
  }
  const settings = await deps.prisma.deploymentSettings.findUnique({
    where: { id: "default" },
  });
  return {
    provider: settings?.defaultModelProvider ?? "scripted",
    id: settings?.defaultModelId ?? "scripted",
    apiKey: undefined,
  };
}

async function postGoJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: deadlineSignal(TASK_DETECT_HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`task-detect endpoint ${url} failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}
