import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  isModelCredentialRejected,
  isRetryableProviderUnavailable,
  isTransientModelError,
} from "@rakazo/adapter-kit";
import { isContentFilterRejection } from "@rakazo/core";
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
 * The decision for a failed call. With MODEL_RETRY_RULES_URL set, the rules service on this host
 * (the Go gateway) answers and its answer is used; a service that cannot answer in time, or
 * answers with anything but a decision, leaves the runtime's own rules in charge. A decision the
 * two disagree on is logged, so the implementations cannot drift apart unnoticed.
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
  if (!url || signal.aborted) return local;
  let remote: ModelRetryDecision;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, provider, requestLimitTooSmall }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(RULES_SERVICE_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    remote = parseDecision(await response.json());
  } catch (cause) {
    // A run stopping mid-question is not the service's failure.
    if (!signal.aborted) {
      getLogger().warn("model.retry_rules.unavailable", {
        runId: log.runId,
        provider,
        model: log.model,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return local;
  }
  if (!sameDecision(local, remote)) {
    getLogger().warn("model.retry_rules.mismatch", {
      runId: log.runId,
      provider,
      model: log.model,
      local: JSON.stringify(local),
      remote: JSON.stringify(remote),
    });
  }
  return remote;
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
