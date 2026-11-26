import {
  isRetryableError,
  isServerUnreachable,
  reconnectDelayMs,
  retryDelayMs,
} from "@rakazo/core";
import { noteServerReachable, subscribeServerReachable } from "./connection-state";

/**
 * Follows a server stream until stopped: reconnects after it drops, backs off while it cannot
 * open, and gives up on a refusal, calling `onRefused`. Returns the stop function.
 */
export function followStream<T>(
  open: (signal: AbortSignal) => Promise<AsyncIterable<T>>,
  onFrame: (frame: T) => void,
  onRefused?: () => void,
): () => void {
  let active = true;
  let controller: AbortController | undefined;
  let cancelRetry: (() => void) | undefined;
  void (async () => {
    while (active) {
      controller = new AbortController();
      let failure: unknown;
      let opened = false;
      try {
        const stream = await open(controller.signal);
        opened = true;
        noteServerReachable(true);
        for await (const frame of stream) {
          if (!active) return;
          onFrame(frame);
        }
      } catch (cause) {
        failure = cause;
        if (isServerUnreachable(cause)) noteServerReachable(false);
      } finally {
        controller.abort();
      }
      if (!active) return;
      if (failure !== undefined && !isRetryableError(failure)) {
        onRefused?.();
        return;
      }
      await new Promise<void>((resolve) => {
        let unsubscribe: (() => void) | undefined;
        const retried = () => {
          unsubscribe?.();
          resolve();
        };
        const timer = setTimeout(
          retried,
          opened ? reconnectDelayMs(failure) : retryDelayMs(failure, 1_000),
        );
        unsubscribe = subscribeServerReachable((reachable) => {
          // A connection that came back should reopen the stream now, not after the backoff.
          if (reachable) cancelRetry?.();
        });
        cancelRetry = () => {
          clearTimeout(timer);
          retried();
        };
      });
      cancelRetry = undefined;
    }
  })();
  return () => {
    active = false;
    controller?.abort();
    cancelRetry?.();
  };
}
