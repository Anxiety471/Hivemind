import type { ThreadMessage } from "@rakazo/contracts";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createSpaceRpc } from "../query/rpc";
import type { WebOutboxRpcResolver, WebSendAttempt } from "./send-outbox";
import {
  claimWebEchoMessage,
  confirmWebEchoes,
  getWebOutboxAttempts,
  isWebEchoMessageClaimed,
  matchesInFlightEcho,
  registerWebThreadScreen,
  startWebOutbox,
  subscribeWebOutbox,
} from "./send-outbox";

/** The thread rows an in-flight echo can arrive as: what the transcript already holds. */
export type OutboxThreadMessage = Pick<ThreadMessage, "id" | "seq" | "role" | "blocks" | "author">;

/**
 * The queued sends this chat shows: still waiting, or accepted but not yet echoed by the thread.
 * The queue itself lives outside React, so its timers and connection listeners survive re-renders.
 */
export function useWebOutbox({
  threadKey,
  userId,
  spaceId,
  echoedSeqs,
  activeMessages,
  rpcForSpace,
}: {
  threadKey: string | undefined;
  userId: string;
  spaceId: string | null;
  /** The seqs the thread already shows; derived from `activeMessages` when it is passed. */
  echoedSeqs?: ReadonlySet<number>;
  /** The messages the chat shows now, for hiding a send the server echoed ahead of its answer. */
  activeMessages?: readonly OutboxThreadMessage[];
  rpcForSpace?: WebOutboxRpcResolver;
}): readonly WebSendAttempt[] {
  const allAttempts = useSyncExternalStore(
    subscribeWebOutbox,
    getWebOutboxAttempts,
    getWebOutboxAttempts,
  );
  const echoSeqs = useMemo(() => {
    if (echoedSeqs) return echoedSeqs;
    const seqs = new Set<number>();
    for (const message of activeMessages ?? []) seqs.add(message.seq);
    return seqs;
  }, [echoedSeqs, activeMessages]);
  const rpcForSpaceRef = useRef(rpcForSpace);
  // Assigned while rendering: a send enqueued by the same click must resolve its Space's client
  // against this render's resolver, not the previous one.
  rpcForSpaceRef.current = rpcForSpace;
  useEffect(() => {
    // One resolver per account start: the effect must not restart when a caller passes a new one.
    const resolver: WebOutboxRpcResolver = (forSpaceId) =>
      rpcForSpaceRef.current ? rpcForSpaceRef.current(forSpaceId) : createSpaceRpc(forSpaceId);
    return startWebOutbox({ userId, rpcForSpace: resolver });
  }, [userId]);
  useEffect(() => {
    if (!threadKey) return;
    return registerWebThreadScreen(threadKey);
  }, [threadKey]);
  useEffect(() => {
    if (!threadKey) return;
    confirmWebEchoes(threadKey, echoSeqs);
  }, [threadKey, echoSeqs]);
  return useMemo(() => {
    // One echoed message explains one attempt: two identical sends must not both disappear.
    const claimedEchoIds = new Set<string>();
    const shown: WebSendAttempt[] = [];
    for (const attempt of allAttempts) {
      if (attempt.payload.originThreadKey !== threadKey) continue;
      if (attempt.scope.userId !== userId) continue;
      if (attempt.scope.spaceId !== spaceId) continue;
      // The thread shows the accepted message: the queue's copy of it retires at once.
      if (attempt.acceptedSeq !== undefined && echoSeqs.has(attempt.acceptedSeq)) continue;
      if (attempt.state === "pending" && attempt.acceptedSeq === undefined && activeMessages) {
        const echo = activeMessages.find(
          (message) =>
            !claimedEchoIds.has(message.id) &&
            !isWebEchoMessageClaimed(message.id) &&
            matchesInFlightEcho(attempt, message, userId),
        );
        if (echo) {
          claimedEchoIds.add(echo.id);
          // Remembered outside this render: the attempt leaves the queue once its seq arrives,
          // and a later identical send must not claim the same message as its own echo.
          claimWebEchoMessage(echo.id);
          continue;
        }
      }
      shown.push(attempt);
    }
    return shown;
  }, [allAttempts, threadKey, userId, spaceId, echoSeqs, activeMessages]);
}
