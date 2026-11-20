import type { AssistantMessage } from "@earendil-works/pi-ai";
import { deferred } from "@rakazo/core/test-async";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
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
          model: "primary",
        }),
      }),
    );
  });

  it("logs who decided, which rule placed the failure and its status, never the provider's text", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    const filtered =
      '400 data: {"error":{"code":"data_inspection_failed","message":"Input text data may contain inappropriate content."}}';
    vi.stubEnv("MODEL_RETRY_RULES_URL", RULES_URL);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ switchToBackup: true, retrySameModel: false, unrecognized: null }),
          ),
      ),
    );
    await decide(filtered);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await decide(unexplained);
    const decided = sink.events.filter((event) => event.message === "model.retry.decided");
    expect(decided).toEqual([
      expect.objectContaining({
        provider: "provider-a",
        model: "primary",
        "retry.source": "gateway",
        "retry.rule": "content_filter",
        "retry.switch_to_backup": true,
        "retry.same_model": false,
        "retry.unrecognized": false,
        "error.kind": "output",
        "error.status": 400,
        "retry.rules_ms": expect.any(Number),
      }),
      expect.objectContaining({
        "retry.source": "local_fallback",
        "retry.rule": "unrecognized",
        "retry.switch_to_backup": true,
        "retry.same_model": true,
        "retry.unrecognized": true,
        "error.kind": "unclassified",
      }),
    ]);
    expect(JSON.stringify(decided)).not.toContain("inappropriate");
    expect(JSON.stringify(decided)).not.toContain("choices");
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
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        requestSignal = init.signal ?? undefined;
        const { promise, reject } = deferred<Response>();
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        return promise;
      }),
    );
    await expect(decide("HTTP 503 unavailable")).resolves.toEqual({
      switchToBackup: true,
      retrySameModel: true,
    });
    expect(requestSignal?.reason).toMatchObject({ name: "TimeoutError" });
  });
});
