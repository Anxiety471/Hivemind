// @vitest-environment jsdom
import { deferred, flush } from "@rakazo/core/test-async";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.hoisted(() => vi.fn());
vi.mock("../auth/auth", () => ({ authClient: { $store: { notify } } }));

import {
  isBrowserOnline,
  isServerReachable,
  noteServerReachable,
  resetServerReachableForTests,
  subscribeServerReachable,
  useServerReachable,
} from "./connection-state";
import { followStream } from "./follow-stream";
import { rpc } from "./rpc";

/** A stream that stays open until the test releases it. */
function heldStream<T>(release: Promise<void>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        await release;
        return { done: true, value: undefined };
      },
    }),
  };
}

beforeEach(() => {
  resetServerReachableForTests(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetServerReachableForTests(true);
});

describe("server reachability", () => {
  it("tracks the browser's online state", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(isBrowserOnline()).toBe(false);
    vi.stubGlobal("navigator", { onLine: true });
    expect(isBrowserOnline()).toBe(true);
    vi.stubGlobal("navigator", undefined);
    expect(isBrowserOnline()).toBe(true);
  });

  it("tells listeners about each transition only, and stops after unsubscribing", () => {
    const changed = vi.fn();
    const unsubscribe = subscribeServerReachable(changed);

    noteServerReachable(true);
    expect(changed).not.toHaveBeenCalled();
    noteServerReachable(false);
    noteServerReachable(false);
    expect(changed).toHaveBeenCalledExactlyOnceWith(false);
    expect(isServerReachable()).toBe(false);

    noteServerReachable(true);
    expect(changed).toHaveBeenCalledTimes(2);

    unsubscribe();
    noteServerReachable(false);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("resets for a test without announcing a transition", () => {
    const changed = vi.fn();
    const unsubscribe = subscribeServerReachable(changed);

    resetServerReachableForTests(false);

    expect(isServerReachable()).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("follows the window's online and offline events", () => {
    window.dispatchEvent(new Event("offline"));
    expect(isServerReachable()).toBe(false);

    window.dispatchEvent(new Event("online"));
    expect(isServerReachable()).toBe(true);
  });
});

describe("followStream", () => {
  it("counts an opened stream as a reachable server", async () => {
    resetServerReachableForTests(false);
    const release = deferred();
    const stop = followStream(
      async () => heldStream<number>(release.promise),
      () => {},
    );

    await vi.waitFor(() => expect(isServerReachable()).toBe(true));

    stop();
    release.resolve();
  });

  it("counts a dropped connection as an unreachable server", async () => {
    const open = vi
      .fn<() => Promise<AsyncIterable<number>>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementation(() => new Promise<AsyncIterable<number>>(() => {}));
    const stop = followStream(open, () => {});

    await vi.waitFor(() => expect(isServerReachable()).toBe(false));
    expect(open).toHaveBeenCalledOnce();

    stop();
  });

  it("reopens at once when the server is reachable again, without waiting out the backoff", async () => {
    const first = deferred<AsyncIterable<number>>();
    const open = vi
      .fn<() => Promise<AsyncIterable<number>>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(() => new Promise<AsyncIterable<number>>(() => {}));
    const stop = followStream(open, () => {});

    // A long Retry-After would keep the stream down for minutes if only the timer could wake it.
    first.reject(Object.assign(new TypeError("Failed to fetch"), { retryAfterMs: 300_000 }));
    await flush();
    expect(open).toHaveBeenCalledOnce();
    expect(isServerReachable()).toBe(false);

    noteServerReachable(true);

    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    stop();
  });
});

describe("rpc response metadata", () => {
  it("keeps the HTTP status and Retry-After of a failure oRPC cannot decode", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<html>Bad Gateway</html>", { status: 502, headers: { "retry-after": "30" } }),
      )
      .mockResolvedValueOnce(new Response("<html>Slow down</html>", { status: 429 }));
    vi.stubGlobal("fetch", fetch);

    const badGateway = await rpc.me().catch((error: unknown) => error);
    expect(badGateway).toMatchObject({ status: 502, retryAfterMs: 30_000 });
    expect(isServerReachable()).toBe(false);

    const tooMany = await rpc.me().catch((error: unknown) => error);
    expect(tooMany).toMatchObject({ status: 429 });
    expect(tooMany).not.toHaveProperty("retryAfterMs");
    expect(isServerReachable()).toBe(true);
  });
});

describe("useServerReachable", () => {
  it("re-renders a component as the server stops and starts answering", async () => {
    function Probe() {
      return createElement("span", null, String(useServerReachable()));
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(createElement(Probe)));
    expect(container.textContent).toBe("true");

    await act(async () => noteServerReachable(false));
    expect(container.textContent).toBe("false");

    await act(async () => noteServerReachable(true));
    expect(container.textContent).toBe("true");

    await act(async () => root.unmount());
  });
});
