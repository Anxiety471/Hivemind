import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  isModelCredentialRejected,
  isRetryableProviderUnavailable,
  isTransientModelError,
  modelErrorStatus,
} from "@rakazo/adapter-kit";
import { deadlineSignal, isContentFilterRejection, normalizeRunError } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { unrecognizedModelFailure } from "./pi-runtime-errors.js";

/** What the fallback loop does with a provider failure that arrived before any visible output. */
export interface ModelRetryDecision {
  /** Another configured model should serve the request. */
  switchToBackup: boolean;
  /** With no backup left, the same model may be asked again. */
  retrySameModel: boolean;
  /** Set when no rule places the failure; `status` is the provider's, when it gave one. */
  unrecognized?: { status: number | undefined };
}

/** An unreachable rules service delays a failed call by at most this much. */
const RULES_SERVICE_TIMEOUT_MS = 500;

/**
 * The runtime's own rules. A placed failure (an outage, a rejected credential, a content filter,
 * a request too large for the model) and one nothing explains both move to a backup. Only a
 * transient failure, or an unexplained one the provider gave no status for, asks the same model
 * again: a status means the provider refused this exact request.
 */
export function localModelRetryDecision(
  message: string,
  provider: string,
  requestLimitTooSmall: boolean,
): ModelRetryDecision {
  const placed =
    requestLimitTooSmall ||
    isRetryableProviderUnavailable(message) ||
    isModelCredentialRejected(message) ||
    isContentFilterRejection(message);
  if (placed) return { switchToBackup: true, retrySameModel: isTransientModelError(message) };
  const unrecognized = unrecognizedModelFailure(message, provider);
  if (!unrecognized) return { switchToBackup: false, retrySameModel: false };
  return {
    switchToBackup: true,
    retrySameModel: isTransientModelError(message) || unrecognized.status === undefined,
    unrecognized,
  };
}

/**
 * Which rule placed a failure, named for the logs. The decision does not depend on which of
 * several matching rules is named here; the order only picks the most specific name.
 */
export type ModelRetryRule =
  | "request_limit"
  | "content_filter"
  | "credential"
  | "transient"
  | "exhausted"
  | "unrecognized"
  | "permanent";

export function modelRetryRule(
  message: string,
  provider: string,
  requestLimitTooSmall: boolean,
): ModelRetryRule {
  if (requestLimitTooSmall) return "request_limit";
  if (isContentFilterRejection(message)) return "content_filter";
  if (isModelCredentialRejected(message)) return "credential";
  if (isRetryableProviderUnavailable(message)) {
    return isTransientModelError(message) ? "transient" : "exhausted";
  }
  return unrecognizedModelFailure(message, provider) ? "unrecognized" : "permanent";
}

/** Who answered: the rules service, the runtime because none is set, or the runtime after the service failed. */
type DecisionSource = "gateway" | "local" | "local_fallback";

/**
 * The decision for a failed call. With MODEL_RETRY_RULES_URL set, the rules service on this host
 * (the Go gateway) answers and its answer is used; a service that cannot answer in time, or
 * answers with anything but a decision, leaves the runtime's own rules in charge. A decision the
 * two disagree on is logged, so the implementations cannot drift apart unnoticed.
 *
 * Every decision is logged as `model.retry.decided`, with what kind of failure it was, which rule
 * placed it and who decided, so how failed calls are handled can be studied from the logs. The
 * provider's message is not logged here: it can quote the request.
 */
export async function modelRetryDecision(
  error: AssistantMessage,
  provider: string,
  requestLimitTooSmall: boolean,
  signal: AbortSignal,
  log: { runId?: string; model: string },
): Promise<ModelRetryDecision> {
  const message = error.errorMessage ?? "Model request failed.";
  const local = localModelRetryDecision(message, provider, requestLimitTooSmall);
  const url = process.env.MODEL_RETRY_RULES_URL?.trim();
  const fields = { runId: log.runId, provider, model: log.model };
  const decided = (decision: ModelRetryDecision, source: DecisionSource, rulesMs?: number) => {
    const classified = normalizeRunError(message);
    const status = modelErrorStatus(message) ?? classified.status;
    getLogger().info("model.retry.decided", {
      ...fields,
      "retry.source": source,
      "retry.rule": modelRetryRule(message, provider, requestLimitTooSmall),
      "retry.switch_to_backup": decision.switchToBackup,
      "retry.same_model": decision.retrySameModel,
      "retry.unrecognized": decision.unrecognized !== undefined,
      "error.kind": classified.kind ?? "unclassified",
      ...(status !== undefined ? { "error.status": status } : {}),
      ...(rulesMs !== undefined ? { "retry.rules_ms": rulesMs } : {}),
    });
    return decision;
  };
  if (!url || signal.aborted) return decided(local, "local");
  const started = performance.now();
  let remote: ModelRetryDecision;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
        provider,
        requestLimitTooSmall,
        runId: log.runId,
        model: log.model,
      }),
      signal: deadlineSignal(RULES_SERVICE_TIMEOUT_MS, signal),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    remote = parseDecision(await response.json());
  } catch (cause) {
    // A run stopping mid-question is not the service's failure.
    if (signal.aborted) return local;
    getLogger().warn("model.retry_rules.unavailable", {
      ...fields,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
    return decided(local, "local_fallback", Math.round(performance.now() - started));
  }
  if (!sameDecision(local, remote)) {
    getLogger().warn("model.retry_rules.mismatch", {
      ...fields,
      local: JSON.stringify(local),
      remote: JSON.stringify(remote),
    });
  }
  return decided(remote, "gateway", Math.round(performance.now() - started));
}

function parseDecision(value: unknown): ModelRetryDecision {
  const record = value as Record<string, unknown> | null;
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.switchToBackup !== "boolean" ||
    typeof record.retrySameModel !== "boolean"
  ) {
    throw new Error("The rules service answered without a decision");
  }
  const decision: ModelRetryDecision = {
    switchToBackup: record.switchToBackup,
    retrySameModel: record.retrySameModel,
  };
  if (record.unrecognized === null || record.unrecognized === undefined) return decision;
  const status = (record.unrecognized as Record<string, unknown> | null)?.status;
  if (status !== null && !(typeof status === "number" && Number.isInteger(status))) {
    throw new Error("The rules service answered with a malformed status");
  }
  return { ...decision, unrecognized: { status: status ?? undefined } };
}

function sameDecision(a: ModelRetryDecision, b: ModelRetryDecision): boolean {
  return (
    a.switchToBackup === b.switchToBackup &&
    a.retrySameModel === b.retrySameModel &&
    (a.unrecognized === undefined) === (b.unrecognized === undefined) &&
    a.unrecognized?.status === b.unrecognized?.status
  );
}
