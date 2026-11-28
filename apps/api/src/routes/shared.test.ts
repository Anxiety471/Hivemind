import { getEventListeners } from "node:events";
import { IDLE_TIMEOUT_MS } from "@rakazo/core";
import { deferred } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT,
  HEARTBEAT_MS,
  INITIAL_HEARTBEAT_MS,
  streamChunkedResponse,
  withHeartbeats,
} from "./shared.js";

afterEach(() => {
  vi.useRealTimers();
});

/** Whether a read is still waiting after this turn, without resolving the read itself. */
function stillWaiting(read: Promise<unknown>): Promise<boolean> {
  return Promise.race([read.then(() => false), Promise.resolve(true)]);
}

describe("withHeartbeats", () => {
  it("beats often enough that a client's idle timeout survives a missed beat", () => {
    expect(2 * HEARTBEAT_MS).toBeLessThan(IDLE_TIMEOUT_MS);
  });

  it("answers a slow first read with a heartbeat long before the steady interval", async () => {
    vi.useFakeTimers();
    const stream = withHeartbeats({}, async function* () {
      await new Promise<never>(() => {});
      yield "never";
    });

    const first = stream.next();
    await vi.advanceTimersByTimeAsync(INITIAL_HEARTBEAT_MS - 1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(first).resolves.toEqual({ done: false, value: HEARTBEAT });
    await stream.return(undefined);
  });

  it("keeps the in-flight read across heartbeats so events stay in order", async () => {
    vi.useFakeTimers();
    const release = deferred();
    const reads = vi.fn();
    async function* follow() {
      reads();
      await release.promise;
      yield "first";
      yield "second";
    }
    const stream = withHeartbeats({}, follow);

    const heartbeat = stream.next();
    await vi.advanceTimersByTimeAsync(INITIAL_HEARTBEAT_MS);
    await expect(heartbeat).resolves.toEqual({ done: false, value: HEARTBEAT });

    const first = stream.next();
    release.resolve();
    await expect(first).resolves.toEqual({ done: false, value: "first" });
    await expect(stream.next()).resolves.toEqual({ done: false, value: "second" });
    expect(reads).toHaveBeenCalledOnce();
    await stream.return(undefined);
  });

  it("uses the steady interval once a first frame has gone out", async () => {
    vi.useFakeTimers();
    const stream = withHeartbeats({}, async function* () {
      await new Promise<never>(() => {});
      yield "never";
    });

    const first = stream.next();
    await vi.advanceTimersByTimeAsync(INITIAL_HEARTBEAT_MS);
    await expect(first).resolves.toEqual({ done: false, value: HEARTBEAT });

    const second = stream.next();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - 1);
    await expect(stillWaiting(second)).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toEqual({ done: false, value: HEARTBEAT });
    await stream.return(undefined);
  });

  it("takes its intervals from the caller", async () => {
    vi.useFakeTimers();
    const stream = withHeartbeats(
      {},
      async function* () {
        await new Promise<never>(() => {});
        yield "never";
      },
      { initialHeartbeatMs: 50, heartbeatMs: 100 },
    );

    const first = stream.next();
    await vi.advanceTimersByTimeAsync(50);
    await expect(first).resolves.toEqual({ done: false, value: HEARTBEAT });
    const second = stream.next();
    await vi.advanceTimersByTimeAsync(99);
    await expect(stillWaiting(second)).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toEqual({ done: false, value: HEARTBEAT });
    await stream.return(undefined);
  });

  it("holds no abort listener once each event is delivered", async () => {
    const request = new AbortController();
    const stream = withHeartbeats({ signal: request.signal }, async function* () {
      for (let i = 0; i < 50; i++) yield i;
    });

    for (let i = 0; i < 50; i++) await stream.next();

    expect(getEventListeners(request.signal, "abort")).toHaveLength(0);
    await stream.return(undefined);
  });

  it("does not start reading when the request has already aborted", async () => {
    const request = new AbortController();
    request.abort();
    const reads = vi.fn();
    const stream = withHeartbeats({ signal: request.signal }, async function* () {
      reads();
      yield "event";
    });

    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
    expect(reads).not.toHaveBeenCalled();
  });

  it("ends on revocation without waiting for a read the abort never lands on", async () => {
    vi.useFakeTimers();
    let sourceSignal: AbortSignal | undefined;
    const stillAuthorized = vi.fn(async () => false);
    const stream = withHeartbeats({ stillAuthorized }, async function* (signal) {
      sourceSignal = signal;
      await new Promise<never>(() => {});
      yield "never";
    });

    const first = stream.next();
    await vi.advanceTimersByTimeAsync(INITIAL_HEARTBEAT_MS);
    await expect(first).resolves.toEqual({ done: false, value: HEARTBEAT });

    // Every wake after the first heartbeat waits the steady interval, and re-checks the session.
    const ended = expect(stream.next()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await ended;
    expect(stillAuthorized).toHaveBeenCalledOnce();
    expect(sourceSignal?.aborted).toBe(true);
  });

  it("ends when the request aborts, without re-checking the session or waiting for the source", async () => {
    vi.useFakeTimers();
    const request = new AbortController();
    const stillAuthorized = vi.fn(async () => true);
    const stream = withHeartbeats({ signal: request.signal, stillAuthorized }, async function* () {
      await new Promise<never>(() => {});
      yield "never";
    });

    const first = stream.next();
    await vi.advanceTimersByTimeAsync(INITIAL_HEARTBEAT_MS - 1);
    request.abort();
    await expect(first).resolves.toEqual({ done: true, value: undefined });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(stillAuthorized).not.toHaveBeenCalled();
  });
});

describe("streamChunkedResponse", () => {
  it("says it started before the producer's first chunk, then streams and ends with its result", async () => {
    async function* produce(_signal: AbortSignal): AsyncGenerator<string, string> {
      yield "one";
      yield "two";
      return "done";
    }

    const frames: unknown[] = [];
    for await (const frame of streamChunkedResponse({}, produce))
      frames.push(frame.type === "chunk" || frame.type === "result" ? { ...frame } : frame.type);
    expect(frames).toEqual([
      "started",
      { type: "chunk", data: "one" },
      { type: "chunk", data: "two" },
      { type: "result", data: "done" },
    ]);
  });

  it("starts at once while the producer is still working, and heartbeats in the quiet", async () => {
    vi.useFakeTimers();
    const release = deferred();
    async function* produce(_signal: AbortSignal): AsyncGenerator<string, string> {
      await release.promise;
      yield "late";
      return "done";
    }

    const stream = streamChunkedResponse({}, produce, {
      initialHeartbeatMs: 50,
      heartbeatMs: 1_000,
    });
    await expect(stream.next()).resolves.toEqual({ done: false, value: { type: "started" } });
    const heartbeat = stream.next();
    await vi.advanceTimersByTimeAsync(50);
    await expect(heartbeat).resolves.toEqual({ done: false, value: { type: "heartbeat" } });

    const chunk = stream.next();
    release.resolve();
    await expect(chunk).resolves.toEqual({ done: false, value: { type: "chunk", data: "late" } });
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { type: "result", data: "done" },
    });
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("ends without a result when the client has gone", async () => {
    vi.useFakeTimers();
    const request = new AbortController();
    async function* produce(_signal: AbortSignal): AsyncGenerator<string, string> {
      await new Promise<never>(() => {});
      yield "never";
      return "done";
    }

    const stream = streamChunkedResponse({ signal: request.signal }, produce);
    await expect(stream.next()).resolves.toEqual({ done: false, value: { type: "started" } });
    const heartbeat = stream.next();
    await vi.advanceTimersByTimeAsync(INITIAL_HEARTBEAT_MS);
    await expect(heartbeat).resolves.toEqual({ done: false, value: { type: "heartbeat" } });
    request.abort();
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
