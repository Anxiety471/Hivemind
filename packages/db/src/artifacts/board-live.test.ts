import { flush } from "@rakazo/core/test-async";
import { describe, expect, it, vi } from "vitest";
import { createBoardEvents } from "./board-live.js";

function fakeFanout() {
  const subscribers = new Map<string, Set<(payload: string) => void>>();
  return {
    publish: async (topic: string, payload: string) => {
      for (const subscriber of subscribers.get(topic) ?? []) subscriber(payload);
    },
    subscribe: (topic: string, callback: (payload: string) => void) => {
      const set = subscribers.get(topic) ?? new Set();
      set.add(callback);
      subscribers.set(topic, set);
      return Promise.resolve(async () => {
        set.delete(callback);
      });
    },
  };
}

describe("createBoardEvents", () => {
  it("follows only the requested space and yields the change", async () => {
    const fanout = fakeFanout();
    const events = createBoardEvents(fanout as never);
    const iterator = events.follow("space-1")[Symbol.asyncIterator]();
    const pending = iterator.next();
    await flush();
    await events.notify("space-2", { ticketId: "other" });
    await events.notify("space-1", { boardId: "board-1", ticketId: "ticket-1" });

    const first = await pending;
    expect(first.value).toMatchObject({
      spaceId: "space-1",
      boardId: "board-1",
      ticketId: "ticket-1",
    });
    await iterator.return?.(undefined);
  });

  it("does not throw without a realtime fanout", async () => {
    const events = createBoardEvents();
    await expect(events.notify("space-1")).resolves.toBeUndefined();
  });

  it("retries a signal through a temporary database outage", async () => {
    let attempts = 0;
    const delivered: string[] = [];
    const fanout = {
      publish: async (topic: string) => {
        attempts += 1;
        if (attempts === 1) {
          // A database failover: the connection died before the signal reached Postgres.
          throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "57P03" });
        }
        delivered.push(topic);
      },
      subscribe: async () => async () => {},
    };
    const events = createBoardEvents(fanout as never);
    vi.useFakeTimers();
    try {
      await events.notify("space-1", { ticketId: "ticket-1" });
      await vi.advanceTimersByTimeAsync(300);
      expect(attempts).toBe(2);
      expect(delivered).toEqual(["board:space-1"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
