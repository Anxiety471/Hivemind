import type { AssistantMessage } from "@earendil-works/pi-ai";
import { deferred } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelRetryDecision } from "./model-retry-rules.js";

const RULES_URL = "http://127.0.0.1:3200/internal/model-retry/decide";

function failure(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "provider-a",
    model: "primary",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: 0,
  };
}

const unexplained = "Cannot read properties of undefined (reading 'choices')";

function decide(message: string, signal = new AbortController().signal) {
  return modelRetryDecision(failure(message), "provider-a", false, signal, { model: "primary" });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("modelRetryDecision", () => {
  it("uses the runtime's own rules when no rules service is configured", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(decide(unexplained)).resolves.toEqual({
      switchToBackup: true,
      retrySameModel: true,
      unrecognized: { status: undefined },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks the rules service and follows its answer", async () => {
    vi.stubEnv("MODEL_RETRY_RULES_URL", RULES_URL);
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            switchToBackup: true,
            retrySameModel: false,
            unrecognized: { status: 400 },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(decide(unexplained)).resolves.toEqual({
      switchToBackup: true,
      retrySameModel: false,
      unrecognized: { status: 400 },
    });
    expect(fetch).toHaveBeenCalledWith(
      RULES_URL,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          message: unexplained,
          provider: "provider-a",
          requestLimitTooSmall: false,
        }),
      }),
    );
  });

  it.each([
    ["an error status", async () => new Response("Not Found", { status: 404 })],
    ["no decision", async () => new Response(JSON.stringify({ switchToBackup: "yes" }))],
    [
      "a malformed status",
      async () =>
        new Response(
          JSON.stringify({
            switchToBackup: true,
            retrySameModel: true,
            unrecognized: { status: "x" },
          }),
        ),
    ],
    [
      "a refused connection",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("falls back to its own rules when the service answers with %s", async (_label, answer) => {
    vi.stubEnv("MODEL_RETRY_RULES_URL", RULES_URL);
    vi.stubGlobal("fetch", vi.fn(answer));
    await expect(
      decide('400 data: {"error":{"code":"data_inspection_failed","message":"Filtered."}}'),
    ).resolves.toEqual({ switchToBackup: true, retrySameModel: false });
  });

  it("stops waiting for a service that does not answer", async () => {
    vi.stubEnv("MODEL_RETRY_RULES_URL", RULES_URL);
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const { promise, reject } = deferred<Response>();
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        return promise;
      }),
    );
    const started = Date.now();
    await expect(decide("HTTP 503 unavailable")).resolves.toEqual({
      switchToBackup: true,
      retrySameModel: true,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
