import { randomUUID } from "node:crypto";
import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { recordUsage } from "@rakazo/db";
import { resolveAutoReviewProviderKind } from "../../approvals/auto-review.js";
import { outermostJsonObject } from "../../models/model-json.js";
import { effectiveModelRole } from "../../models/model-roles.js";
import {
  finalReplyDecisionInstructions,
  renderFinalReplyDecisionPrompt,
} from "../assembly/final-reply-decision.prompt.js";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { resolveConnectedRunModel } from "./run-model.js";

const JUDGE_TIMEOUT_MS = 20_000;

/** True only for an explicit `{"needsDecision": true}`; anything unparsable is no decision. */
export function parseFinalReplyDecision(raw: string): boolean {
  const object = outermostJsonObject(raw);
  if (!object) return false;
  try {
    return (JSON.parse(object) as { needsDecision?: unknown }).needsDecision === true;
  } catch {
    return false;
  }
}

/**
 * One small model call that answers whether a final reply leaves a decision for the user. It
 * runs with no tools and no history, on the model it is given (the approval checker or the run's
 * own model), and its usage is recorded as setup work. Errors and timeouts reject to the caller.
 */
export async function judgeFinalReplyDecision(input: {
  runtime: AgentRuntime;
  prisma: PrismaClient;
  model: AgentRunRequest["model"];
  reply: string;
  ids: { spaceId: string; userId: string; botId: string };
}): Promise<boolean> {
  const { runtime, prisma, model, ids } = input;
  const judgeId = `final-reply-judge:${randomUUID()}`;
  const usage = (event: Extract<AgentRuntimeEvent, { type: "usage" }>) =>
    recordUsage(prisma, event, {
      spaceId: ids.spaceId,
      botId: ids.botId,
      userId: ids.userId,
      operationId: judgeId,
      operationKind: "setup",
    });
  let text = "";
  for await (const event of runtime.run(
    {
      botId: ids.botId,
      threadId: judgeId,
      runId: judgeId,
      usageOperationKind: "setup",
      onUsage: async (event) => {
        await usage(event);
      },
      prompt: renderFinalReplyDecisionPrompt(input.reply),
      instructions: finalReplyDecisionInstructions(),
      history: [],
      tools: [],
      model,
    },
    {
      operationId: judgeId,
      traceId: judgeId,
      spaceId: ids.spaceId,
      userId: ids.userId,
      botId: ids.botId,
      signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
    },
  )) {
    if (event.type === "done" && event.text) text = event.text;
    if (event.type === "usage" && !event.accounted) await usage(event);
  }
  return parseFinalReplyDecision(text);
}

/**
 * The judge a run hands its runtime: the approval checker's chat model when one is configured,
 * otherwise the run's own model. The checker is resolved on the first reply, not at run start.
 */
export function finalReplyDecisionJudge(input: {
  deps: ExecutorDeps;
  scope: { userId: string; spaceId: string; botId: string };
  fallbackModel: AgentRunRequest["model"];
  secrets: string[];
  registerSecrets: (values: string[]) => void;
}): (reply: string) => Promise<boolean> {
  const { deps, scope, fallbackModel, secrets } = input;
  let modelPromise: Promise<AgentRunRequest["model"]> | undefined;
  const judgeModel = () =>
    (modelPromise ??= checkerModel(deps, scope, input.registerSecrets).then(
      (checker) => checker ?? fallbackModel,
    ));
  return async (reply) =>
    judgeFinalReplyDecision({
      runtime: deps.runtime,
      prisma: deps.prisma,
      model: await judgeModel(),
      reply: redactSecrets(reply, secrets),
      ids: scope,
    });
}

/** The approval checker's chat model, or null when none is configured or it is not a chat model. */
async function checkerModel(
  deps: ExecutorDeps,
  scope: { userId: string; spaceId: string },
  registerSecrets: (values: string[]) => void,
): Promise<AgentRunRequest["model"] | null> {
  // Judge and checker providers other than the chat kind (scripted, jev) are not chat models.
  if (resolveAutoReviewProviderKind() !== "llm") return null;
  const primary = (await effectiveModelRole(deps.prisma, scope, "approval", {})).primary;
  if (!primary) return null;
  return resolveConnectedRunModel(
    deps,
    scope,
    primary.provider,
    primary.modelId,
    registerSecrets,
    false,
    primary.thinkingLevel,
    primary.credentialId,
  );
}
