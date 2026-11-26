import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createSpaceRpc } from "../query/rpc";
import type { WebOutboxRpcResolver, WebSendAttempt } from "./send-outbox";
import {
  confirmWebEchoes,
  getWebOutboxAttempts,
  registerWebThreadScreen,
  startWebOutbox,
  subscribeWebOutbox,
} from "./send-outbox";

/**
 * The queued sends this chat shows: still waiting, or accepted but not yet echoed by the thread.
 * The queue itself lives outside React, so its timers and connection listeners survive re-renders.
 */
export function useWebOutbox({
  threadKey,
  userId,
  spaceId,
  echoedSeqs,
  rpcForSpace,
}: {
  threadKey: string | undefined;
  userId: string;
  spaceId: string | null;
  echoedSeqs: ReadonlySet<number>;
  rpcForSpace?: WebOutboxRpcResolver;
}): readonly WebSendAttempt[] {
  const allAttempts = useSyncExternalStore(
    subscribeWebOutbox,
    getWebOutboxAttempts,
    getWebOutboxAttempts,
  );
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
    confirmWebEchoes(threadKey, echoedSeqs);
  }, [threadKey, echoedSeqs]);
  return useMemo(
    () =>
      allAttempts.filter(
        (attempt) =>
          attempt.payload.originThreadKey === threadKey &&
          attempt.scope.userId === userId &&
          attempt.scope.spaceId === spaceId &&
          !(attempt.acceptedSeq !== undefined && echoedSeqs.has(attempt.acceptedSeq)),
      ),
    [allAttempts, threadKey, userId, spaceId, echoedSeqs],
  );
}
