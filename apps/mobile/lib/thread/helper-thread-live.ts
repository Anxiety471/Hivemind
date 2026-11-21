import {
  abortableDelay,
  isRetryableError,
  isThreadSnapshotEvent,
  reconnectDelayMs,
  reduceThreadSnapshot,
  retryDelayMs,
} from "@rakazo/core";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../api/api";
import { subscribeHelperThread } from "../api/api-live";
import type { MobileSnapshot } from "../api/mobile-types";
import { currentSessionGeneration } from "../api/session";
import { errorText } from "../api/user-error";
import type { HelperThreadStatus } from "./helper-thread";
import { helperThreadStatus, helperThreadStatusAfterEvent } from "./helper-thread";

/**
 * A helper's thread, read once from its card and kept live from its own stream. The screen holds
 * the last snapshot while it reloads after regaining focus, and a lost stream is one refetch and
 * one resubscribe away; a 4xx is the server's answer and ends the loop.
 */
export function useHelperThreadLive({
  messageId,
  initialStatus,
  active,
}: {
  messageId: string;
  initialStatus: HelperThreadStatus;
  active: boolean;
}) {
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null);
  const snapshotRef = useRef<MobileSnapshot | null>(null);
  const [status, setStatus] = useState<HelperThreadStatus>(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active || !messageId) return;
    const abort = new AbortController();
    const generation = currentSessionGeneration();
    const current = () => !abort.signal.aborted && generation === currentSessionGeneration();
    let backoff = 250;
    const commit = (next: MobileSnapshot | null) => {
      snapshotRef.current = next;
      setSnapshot(next);
    };
    void (async () => {
      while (current()) {
        let next: MobileSnapshot;
        try {
          next = await rpc("threads/helperGet", { messageId }, { signal: abort.signal });
        } catch (failure) {
          if (!current()) return;
          setError(errorText(failure));
          if (!isRetryableError(failure)) return;
          await abortableDelay(retryDelayMs(failure, backoff), abort.signal).catch(() => undefined);
          backoff = Math.min(backoff * 2, 5_000);
          continue;
        }
        if (!current()) return;
        backoff = 250;
        commit(next);
        setError(null);
        setStatus((shown) => helperThreadStatus(next, shown));
        let failure: unknown;
        try {
          // Reconnecting replays every event after the snapshot's cursor, so this loop reads
          // again only when the stream ends and a later iteration starts.
          let cursor = next.cursor ?? -1;
          await subscribeHelperThread(
            next.threadId,
            cursor,
            (event) => {
              if (!current()) return;
              if (typeof event.seq === "number" && event.seq > cursor) cursor = event.seq;
              setStatus((shown) => helperThreadStatusAfterEvent(shown, event));
              if (isThreadSnapshotEvent(event)) {
                const reduced = reduceThreadSnapshot(snapshotRef.current, event);
                if (reduced !== snapshotRef.current) commit(reduced);
              }
            },
            abort.signal,
          );
        } catch (caught) {
          failure = caught;
        }
        if (!current()) return;
        // A 4xx other than 408/429 is the server's answer; reconnecting only polls it.
        if (failure && !isRetryableError(failure)) {
          setError(errorText(failure));
          return;
        }
        await abortableDelay(reconnectDelayMs(failure), abort.signal).catch(() => undefined);
      }
    })();
    return () => abort.abort();
  }, [active, messageId, attempt]);

  return {
    snapshot,
    status,
    error,
    retry: () => {
      setError(null);
      setAttempt((count) => count + 1);
    },
  };
}
