import { ORPCError, ValidationError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { SandboxRateLimitError, SandboxUnavailableError } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { databaseOutage, IsolationError, ProviderTransactionBusyError } from "@rakazo/db";
import { createLogger, getLogContext, installLogger, runWithLogContext } from "@rakazo/logging";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter, handle } from "../router-test-support.js";
import { handleRpcError, setRpcResponseHeaders } from "../rpc-errors.js";
import { isRetryableProcedure, isTransientRpcError, retryTransientRpc } from "./rpc-retry.js";

beforeEach(() => {
  installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
  databaseOutage.succeeded();
});
afterEach(() => {
  vi.useRealTimers();
  installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
  databaseOutage.succeeded();
});

/** Prisma's error while Postgres fails over. */
function unreachable() {
  return Object.assign(new Error("Can't reach database server at db:5432"), { code: "P1001" });
}

describe("isRetryableProcedure", () => {
  it("retries reads and never a write", () => {
    expect(isRetryableProcedure(["bootstrap"])).toBe(true);
    expect(isRetryableProcedure(["threads", "head"])).toBe(true);
    expect(isRetryableProcedure(["threads", "messages"])).toBe(true);
    expect(isRetryableProcedure(["files", "list"])).toBe(true);
    expect(isRetryableProcedure(["threads", "send"])).toBe(false);
    expect(isRetryableProcedure(["threads", "answer"])).toBe(false);
    expect(isRetryableProcedure(["threads", "subscribe"])).toBe(false);
    expect(isRetryableProcedure(["files", "move"])).toBe(false);
  });
});

describe("isTransientRpcError", () => {
  it("accepts a brief upstream or database failure", () => {
    expect(isTransientRpcError(new ProviderTransactionBusyError())).toBe(true);
    expect(isTransientRpcError(new SandboxUnavailableError())).toBe(true);
    expect(isTransientRpcError(new SandboxRateLimitError({ retryAfterMs: 5_000 }))).toBe(true);
    expect(isTransientRpcError(unreachable())).toBe(true);
    expect(isTransientRpcError(new ORPCError("SERVICE_UNAVAILABLE"))).toBe(true);
    expect(isTransientRpcError(Object.assign(new Error("timeout"), { status: 408 }))).toBe(true);
    expect(isTransientRpcError(Object.assign(new Error("slow down"), { status: 429 }))).toBe(true);
  });

  it("refuses a failure the caller caused", () => {
    expect(isTransientRpcError(new ClientError("NOT_FOUND", "Missing"))).toBe(false);
    expect(isTransientRpcError(new IsolationError())).toBe(false);
    expect(isTransientRpcError(new ValidationError({ issues: [], message: "Invalid" }))).toBe(
      false,
    );
    expect(isTransientRpcError(new ORPCError("BAD_REQUEST"))).toBe(false);
    expect(isTransientRpcError(new ORPCError("FORBIDDEN"))).toBe(false);
    const aborted = new Error("This operation was aborted");
    aborted.name = "AbortError";
    expect(isTransientRpcError(aborted)).toBe(false);
  });
});

describe("retryTransientRpc", () => {
  it("retries a read that failed on a busy provider transaction and answers with the final try", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {
      if (run.mock.calls.length < 3) throw new ProviderTransactionBusyError();
      return "read";
    });

    const outcome = retryTransientRpc({ path: ["threads", "head"], run });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toBe("read");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("records the retry count on the request's log context", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {
      if (run.mock.calls.length === 1) throw new ProviderTransactionBusyError();
      return "read";
    });

    const retries = await runWithLogContext({}, async () => {
      const outcome = retryTransientRpc({ path: ["bots", "list"], run });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(outcome).resolves.toBe("read");
      return getLogContext()["rpc.retries"];
    });
    expect(retries).toBe(1);
  });

  it("gives up after three tries and keeps the last failure", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {
      throw new ProviderTransactionBusyError();
    });

    const outcome = retryTransientRpc({ path: ["files", "list"], run });
    const settled = outcome.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(settled).resolves.toBeInstanceOf(ProviderTransactionBusyError);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("does not retry a mutation", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {
      throw new ProviderTransactionBusyError();
    });

    await expect(retryTransientRpc({ path: ["threads", "send"], run })).rejects.toBeInstanceOf(
      ProviderTransactionBusyError,
    );
    expect(run).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry what the caller got wrong", async () => {
    vi.useFakeTimers();
    for (const error of [
      new ClientError("CONFLICT", "Already there"),
      new IsolationError(),
      new ValidationError({ issues: [], message: "Invalid input" }),
      new ORPCError("FORBIDDEN", { message: "Not yours" }),
    ]) {
      const run = vi.fn(async () => {
        throw error;
      });
      await expect(retryTransientRpc({ path: ["bots", "get"], run })).rejects.toBe(error);
      expect(run).toHaveBeenCalledOnce();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the wait as soon as the client disconnects", async () => {
    vi.useFakeTimers();
    const request = new AbortController();
    const run = vi.fn(async () => {
      throw new ProviderTransactionBusyError();
    });

    const outcome = retryTransientRpc({ path: ["bots", "list"], signal: request.signal, run });
    request.abort();
    const rejected = await outcome.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejected).toMatchObject({ name: "AbortError" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("fails fast when the server asked for a wait longer than the interactive cap", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {
      throw new SandboxRateLimitError({ retryAfterMs: 30_000 });
    });

    await expect(retryTransientRpc({ path: ["computer", "status"], run })).rejects.toBeInstanceOf(
      SandboxRateLimitError,
    );
    expect(run).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a temporary refusal's answer", () => {
  /** The reply this failure produces, as the RPC route finishes it. */
  function replyFor(error: unknown): Response {
    return runWithLogContext({}, () => {
      let status = 500;
      try {
        handleRpcError(error, ["rpc", "test"]);
      } catch (thrown) {
        status = thrown instanceof ORPCError ? thrown.status : 500;
      }
      const reply = new Response(null, {
        status,
        headers: { "content-type": "application/json" },
      });
      setRpcResponseHeaders(reply);
      return reply;
    });
  }

  it("tells the client when to ask again after a busy provider transaction", () => {
    const reply = replyFor(new ProviderTransactionBusyError());
    expect(reply.status).toBe(503);
    expect(reply.headers.get("retry-after")).toBe("2");
  });

  it("tells the client when to ask again after a computer provider outage", () => {
    const reply = replyFor(new SandboxUnavailableError());
    expect(reply.status).toBe(503);
    expect(reply.headers.get("retry-after")).toBe("5");
  });

  it("passes on the wait a rate limited computer asked for", () => {
    expect(
      replyFor(new SandboxRateLimitError({ retryAfterMs: 12_000 })).headers.get("retry-after"),
    ).toBe("12");
    expect(replyFor(new SandboxRateLimitError()).headers.get("retry-after")).toBe("5");
  });

  it("keeps a client's own failures free of a retry hint", () => {
    const reply = replyFor(new ClientError("NOT_FOUND", "Missing"));
    expect(reply.headers.get("retry-after")).toBeNull();
  });

  it("tells the client when to ask again after a database outage", () => {
    const reply = replyFor(unreachable());
    expect(reply.status).toBe(503);
    expect(reply.headers.get("retry-after")).toBe("5");
  });
});

describe("setRpcResponseHeaders", () => {
  it("asks proxies not to buffer an event stream", () => {
    const reply = new Response("data: {}\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    setRpcResponseHeaders(reply);
    expect(reply.headers.get("x-accel-buffering")).toBe("no");
  });

  it("keeps a buffering choice the handler already made", () => {
    const reply = new Response("data: {}\n\n", {
      headers: { "content-type": "text/event-stream", "x-accel-buffering": "yes" },
    });
    setRpcResponseHeaders(reply);
    expect(reply.headers.get("x-accel-buffering")).toBe("yes");
  });

  it("leaves an ordinary JSON answer alone", () => {
    const reply = new Response("{}", { headers: { "content-type": "application/json" } });
    setRpcResponseHeaders(reply);
    expect(reply.headers.get("x-accel-buffering")).toBeNull();
  });
});

describe("an event-stream answer", () => {
  it("asks the proxies in front of it to forward chunks as they are written", async () => {
    const follow = {
      next: () => new Promise<never>(() => {}),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
    };
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: null,
        }),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      events: { follow: vi.fn(() => follow) },
      env: { webOrigin: "http://127.0.0.1:5173", screenProxySecret: "fake-test-secret" },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));
    // The same steps the app takes for a matched RPC request.
    const app = new Hono();
    app.use("/rpc/*", async (c, next) => {
      const { matched, response } = await handler.handle(c.req.raw, {
        prefix: "/rpc",
        context: { actor },
      });
      if (!matched) return next();
      const reply = c.newResponse(response.body, response);
      setRpcResponseHeaders(reply);
      return reply;
    });

    const response = await app.request("/rpc/threads/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ json: { botId: "bot-1", cursor: -1 } }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    await response.body?.cancel();
  });
});

describe("a read through the router", () => {
  it("answers from its second try without the caller seeing the transient failure", async () => {
    vi.useFakeTimers();
    const findMany = vi
      .fn()
      .mockRejectedValueOnce(new ProviderTransactionBusyError())
      .mockResolvedValue([]);
    const deps = {
      prisma: { agentImport: { findMany } },
      env: { webOrigin: "http://127.0.0.1:5173", screenProxySecret: "fake-test-secret" },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));

    const answered = handle(
      handler,
      new Request("http://127.0.0.1/rpc/bots/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const response = await answered;
    expect(response.status).toBe(200);
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
