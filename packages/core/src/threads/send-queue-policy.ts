import { errorStatus, retryDelayMs } from "../primitives/retry-policy.js";
import { isServerUnreachable } from "../primitives/user-error.js";
import { isImageInputConfirmation, isModelRequiredSendError } from "../runs/run-error.js";

/** What the outbox does after a send failed. */
export type SendFailureDisposition = "retry_connection" | "failed" | "refused";

/** Statuses a send waits out rather than giving up on. */
const WAIT_STATUSES = new Set([408, 409, 425, 426, 429]);

/**
 * The send's outcome: wait for the connection (the request may never have landed), stop retrying
 * because the server refused this request as it stands, or fail the message.
 */
export function classifySendFailure(
  error: unknown,
  options?: { passwordChanging?: boolean },
): SendFailureDisposition {
  const directStatus = errorStatus(error);
  const causeStatus =
    error && typeof error === "object" && "cause" in error
      ? errorStatus((error as { cause?: unknown }).cause)
      : undefined;
  const status = directStatus ?? causeStatus;
  if (
    isServerUnreachable(error) ||
    status === 408 ||
    status === 429 ||
    (status === 401 && options?.passwordChanging === true)
  ) {
    return "retry_connection";
  }
  if (
    !isModelRequiredSendError(error) &&
    !isImageInputConfirmation(error) &&
    directStatus !== undefined &&
    directStatus >= 400 &&
    directStatus < 500 &&
    !WAIT_STATUSES.has(directStatus)
  ) {
    return "refused";
  }
  return "failed";
}

export const SEND_RETRY_BASE_MS = 1_000;
export const SEND_RETRY_MAX_MS = 30_000;

/** How long the outbox waits before sending again: doubling, capped, and honoring Retry-After. */
export function nextSendRetryDelayMs(
  error: unknown,
  retryCount: number,
  random: () => number = Math.random,
): number {
  const backoffMs = Math.min(
    SEND_RETRY_BASE_MS * 2 ** Math.min(Math.max(retryCount, 0), 5),
    SEND_RETRY_MAX_MS,
  );
  return retryDelayMs(error, backoffMs, random);
}
