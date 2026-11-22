import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type { BoardEvent } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging";
import { retryWhileDatabaseUnavailable } from "../database/database-outage.js";

/**
 * A board signal is the only thing that makes an open board or rail read its tickets, so a
 * publish rides out a short database outage in the background, without holding up the change.
 * Past that it gives up; apps catch up when their stream reopens.
 */
const PUBLISH_RETRY_MS = 15_000;

/** A transient "this board changed" signal. Clients refetch the list on any frame. */
export interface BoardEvents {
  notify(spaceId: string, change?: { boardId?: string; ticketId?: string }): Promise<void>;
  follow(spaceId: string, signal?: AbortSignal): AsyncGenerator<BoardEvent>;
}

export function boardEventTopic(spaceId: string): string {
  return `board:${spaceId}`;
}

/** Without a realtime fanout the notifier does nothing and the stream stays open and empty. */
export function createBoardEvents(realtime?: RealtimeFanout): BoardEvents {
  return {
    notify(spaceId, change) {
      if (!realtime) return Promise.resolve();
      const payload: BoardEvent = {
        spaceId,
        ...(change?.boardId ? { boardId: change.boardId } : {}),
        ...(change?.ticketId ? { ticketId: change.ticketId } : {}),
        createdAt: new Date().toISOString(),
      };
      const topic = boardEventTopic(spaceId);
      const body = JSON.stringify(payload);
      void bestEffort(
        "publish the board signal",
        retryWhileDatabaseUnavailable(() => realtime.publish(topic, body), {
          source: "board signal",
          waitMs: PUBLISH_RETRY_MS,
        }),
      );
      return Promise.resolve();
    },
    async *follow(spaceId, signal) {
      const queue: BoardEvent[] = [];
      const waiters = new Set<() => void>();
      const push = (event: BoardEvent) => {
        queue.push(event);
        for (const wake of [...waiters]) wake();
      };
      const unsubscribe = realtime
        ? await realtime
            .subscribe(boardEventTopic(spaceId), (payload) => {
              let change: { boardId?: string; ticketId?: string } = {};
              try {
                change = JSON.parse(payload) as typeof change;
              } catch {
                change = {};
              }
              push({
                spaceId,
                ...(change.boardId ? { boardId: change.boardId } : {}),
                ...(change.ticketId ? { ticketId: change.ticketId } : {}),
                createdAt: new Date().toISOString(),
              });
            })
            .catch(() => async () => {})
        : async () => {};
      try {
        while (!signal?.aborted) {
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => {
            const wake = () => {
              waiters.delete(wake);
              signal?.removeEventListener("abort", wake);
              resolve();
            };
            waiters.add(wake);
            signal?.addEventListener("abort", wake, { once: true });
            if (signal?.aborted) wake();
          });
        }
      } finally {
        waiters.clear();
        await unsubscribe();
      }
    },
  };
}
