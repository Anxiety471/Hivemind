import { describe, expect, it } from "vitest";
import { MAX_RETRY_AFTER_MS } from "../primitives/retry-policy.js";
import { MODEL_IMAGE_INPUT_UNKNOWN, MODEL_REQUIRED_SEND_ERROR } from "../runs/run-error.js";
import {
  classifySendFailure,
  nextSendRetryDelayMs,
  SEND_RETRY_BASE_MS,
  SEND_RETRY_MAX_MS,
} from "./send-queue-policy.js";

const withStatus = (status: number, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error("failed"), { status, ...extra });

const networkError = (message: string, code?: string) =>
  Object.assign(new TypeError(message), code === undefined ? {} : { code });

describe("classify send failure", () => {
  it("waits for the connection when the request never got a response", () => {
    expect(classifySendFailure(new TypeError("Failed to fetch"))).toBe("retry_connection");
    expect(classifySendFailure(networkError("connect failed", "ECONNREFUSED"))).toBe(
      "retry_connection",
    );
    expect(
      classifySendFailure(Object.assign(new Error("signal timed out"), { name: "TimeoutError" })),
    ).toBe("retry_connection");
  });

  it("waits for the connection on gateway answers, direct or wrapped", () => {
    for (const status of [502, 503, 504]) {
      expect(classifySendFailure(withStatus(status))).toBe("retry_connection");
      expect(classifySendFailure(new Error("send failed", { cause: withStatus(status) }))).toBe(
        "retry_connection",
      );
    }
  });

  it("waits out a rate limit and reads the wait it asked for", () => {
    expect(classifySendFailure(withStatus(408))).toBe("retry_connection");
    const limited = withStatus(429, { retryAfterMs: 4_000 });
    expect(classifySendFailure(limited)).toBe("retry_connection");
    expect(nextSendRetryDelayMs(limited, 0, () => 0)).toBe(4_000);
  });

  it("waits on a 401 only while the password is changing", () => {
    const unauthorized = withStatus(401);
    expect(classifySendFailure(unauthorized, { passwordChanging: false })).toBe("refused");
    expect(classifySendFailure(unauthorized)).toBe("refused");
    expect(classifySendFailure(unauthorized, { passwordChanging: true })).toBe("retry_connection");
  });

  it("refuses a request the server rejected as it stands", () => {
    for (const status of [400, 403, 404, 413, 422]) {
      expect(classifySendFailure(withStatus(status))).toBe("refused");
    }
  });

  it("fails what asking again cannot settle", () => {
    expect(classifySendFailure(withStatus(409))).toBe("failed");
    expect(classifySendFailure(withStatus(426))).toBe("failed");
    expect(classifySendFailure(withStatus(500))).toBe("failed");
    expect(classifySendFailure(new Error(MODEL_REQUIRED_SEND_ERROR))).toBe("failed");
    expect(
      classifySendFailure({ status: 409, data: { reason: "model_image_input_unsupported" } }),
    ).toBe("failed");
    expect(classifySendFailure(new Error(MODEL_IMAGE_INPUT_UNKNOWN))).toBe("failed");
    expect(classifySendFailure(undefined)).toBe("failed");
  });
});

describe("send retry delay", () => {
  it("doubles from the base and stops at the cap", () => {
    const noJitter = () => 1;
    expect(nextSendRetryDelayMs(undefined, 0, noJitter)).toBe(SEND_RETRY_BASE_MS);
    expect(nextSendRetryDelayMs(undefined, 1, noJitter)).toBe(SEND_RETRY_BASE_MS * 2);
    expect(nextSendRetryDelayMs(undefined, 2, noJitter)).toBe(SEND_RETRY_BASE_MS * 4);
    expect(nextSendRetryDelayMs(undefined, 5, noJitter)).toBe(SEND_RETRY_MAX_MS);
    expect(nextSendRetryDelayMs(undefined, 40, noJitter)).toBe(SEND_RETRY_MAX_MS);
    expect(nextSendRetryDelayMs(undefined, -3, noJitter)).toBe(SEND_RETRY_BASE_MS);
  });

  it("jitters a failure down to at most the backoff", () => {
    const lowest = nextSendRetryDelayMs(new Error("failed"), 2, () => 1);
    expect(lowest).toBe((SEND_RETRY_BASE_MS * 4) / 2);
    expect(nextSendRetryDelayMs(new Error("failed"), 2, () => 0)).toBe(SEND_RETRY_BASE_MS * 4);
  });

  it("keeps a server's Retry-After between the backoff and the ceiling", () => {
    expect(nextSendRetryDelayMs({ retryAfterMs: 10 }, 2, () => 0)).toBe(SEND_RETRY_BASE_MS * 4);
    expect(nextSendRetryDelayMs({ retryAfterMs: 8_000 }, 0, () => 0)).toBe(8_000);
    expect(nextSendRetryDelayMs({ retryAfterMs: 60 * 60_000 }, 0, () => 0)).toBe(
      MAX_RETRY_AFTER_MS,
    );
  });
});
