import { Trans, useLingui } from "@lingui/react/macro";
import type { BotAvatarSet, ComputerReleaseReason, ThreadSnapshot } from "@rakazo/contracts";
import {
  activeThreadRuns,
  isRunWorking,
  isThreadSnapshotEvent,
  reduceThreadSnapshot,
  runThreadSubscription,
} from "@rakazo/core";
import { Button, Dialog, DialogClose, DialogContent, DialogTitle, Spinner } from "@rakazo/ui-web";
import { ArrowLeft, XIcon } from "lucide-react";
import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { HelperStatusPill } from "../../../components/messages/SubagentCard";
import { WindowChrome } from "../../../components/WindowChrome";
import type { HelperThreadTarget } from "../../../lib/chat/helper-thread";
import { TRANSCRIPT_CONTENT_PADDING } from "../../../lib/chat/transcript-layout";
import { transcriptIsNearEnd } from "../../../lib/chat/transcript-scroll";
import { desktopBridge } from "../../../lib/platform/desktop";
import type { RpcClient } from "../../../lib/query/rpc";
import { MessageView } from "./message-view";
import { bubbleFrameWidth } from "./transcript";

type HelperStatus = HelperThreadTarget["status"] | "stopped";

/**
 * The live state of the opened helper: its own runs say whether it is still working and
 * whether it failed, while the card it was opened from knows a stopped helper from a failed one.
 */
function helperStatus(
  snapshot: ThreadSnapshot | null,
  target: HelperThreadTarget,
  cancelled: boolean,
): HelperStatus {
  if (!snapshot) return target.stopped || cancelled ? "stopped" : target.status;
  if (activeThreadRuns(snapshot).some((run) => isRunWorking(run.status))) return "running";
  if (cancelled || target.stopped) return "stopped";
  if (snapshot.run?.status === "failed" || target.status === "failed") return "failed";
  return "completed";
}

function useHelperThread(rpc: RpcClient, messageId: string) {
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [cancelled, setCancelled] = useState(false);
  const snapshotRef = useRef<ThreadSnapshot | null>(null);

  useEffect(() => {
    snapshotRef.current = null;
    setSnapshot(null);
    setError(null);
    setCancelled(false);
    const abort = new AbortController();
    const commit = (next: ThreadSnapshot | null) => {
      snapshotRef.current = next;
      setSnapshot(next);
    };
    const load = async () => {
      try {
        const next = await rpc.threads.helperGet({ messageId }, { signal: abort.signal });
        if (abort.signal.aborted) return next;
        commit(next);
        setError(null);
        return next;
      } catch (failure) {
        if (!abort.signal.aborted) setError(failure);
        throw failure;
      }
    };
    void runThreadSubscription({
      signal: abort.signal,
      loadInitial: load,
      loadHead: async () => snapshotRef.current,
      refresh: load,
      currentSnapshot: () => snapshotRef.current,
      subscribe: async (cursor, signal) => {
        const threadId = snapshotRef.current?.threadId;
        if (!threadId) throw new Error("The helper thread is not loaded.");
        return rpc.threads.helperSubscribe({ threadId, cursor }, { signal });
      },
      applyEvent: (event) => {
        if (!isThreadSnapshotEvent(event)) return;
        // Stop cancels the run; the snapshot keeps no cancelled run to read it from.
        if (event.type === "run.cancelled") setCancelled(true);
        commit(reduceThreadSnapshot(snapshotRef.current, event));
      },
      onEvent: () => undefined,
    }).catch((failure: unknown) => {
      // A refusal stops the shared subscription loop; the snapshot error state offers Retry.
      if (!abort.signal.aborted) setError((current: unknown) => current ?? failure);
    });
    return () => abort.abort();
  }, [rpc, messageId, attempt]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  return { snapshot, error, retry, cancelled };
}

/**
 * A background helper's own thread, opened from its saved card and shown read-only: the
 * transcript it wrote, kept live, with no composer. Cards for helpers it started open in turn,
 * and Back returns to the thread that showed the card.
 */
export function HelperThreadView({
  target,
  rpc,
  peerBot,
  onOpenBot,
  onOpenPeerMessages,
  onOpenComputer,
  onReleaseComputer,
  onClose,
}: {
  target: HelperThreadTarget;
  rpc: RpcClient;
  peerBot: (
    botId: string,
  ) => { name?: string; color: string; status?: string; avatarSet?: BotAvatarSet } | undefined;
  onOpenBot: (botId: string) => void;
  onOpenPeerMessages: (peer: { peerBotId: string; peerBotName: string }) => void;
  onOpenComputer: (botId?: string, takeControl?: boolean) => void;
  onReleaseComputer: (
    botId: string,
    runId: string | undefined,
    reason: ComputerReleaseReason,
  ) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const desktop = desktopBridge();
  const [opened, setOpened] = useState<HelperThreadTarget[]>([target]);
  const current = opened[opened.length - 1] ?? target;
  const nested = opened.length > 1;
  const { snapshot, error, retry, cancelled } = useHelperThread(rpc, current.messageId);
  const status = helperStatus(snapshot, current, cancelled);
  const transcriptRef: RefObject<HTMLDivElement | null> = useRef(null);
  const followingEnd = useRef(true);
  // Opens at the latest message, then follows what the helper keeps writing while still there.
  useLayoutEffect(() => {
    const element = transcriptRef.current;
    if (element && followingEnd.current) element.scrollTop = element.scrollHeight;
  }, [snapshot]);
  const openNested = (next: HelperThreadTarget) => {
    followingEnd.current = true;
    setOpened((stack) => [...stack, next]);
  };
  const back = () => {
    followingEnd.current = true;
    setOpened((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack));
  };
  const messages = snapshot?.messages ?? [];
  const botId = snapshot?.botId ?? messages[0]?.botId ?? "";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="helper-thread-view"
        showCloseButton={false}
        className="inset-0 top-0 left-0 flex h-full w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-background p-0 text-foreground ring-0 sm:max-w-none"
      >
        <div
          className={`app-drag grid items-center gap-4 border-b border-sidebar-border px-[18px] py-3.5 ${
            desktop
              ? "grid-cols-[72px_minmax(0,1fr)_72px]"
              : "grid-cols-[1.75rem_minmax(0,1fr)_1.75rem]"
          }`}
        >
          <div>
            {nested ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="app-no-drag"
                aria-label={t`Back`}
                onClick={back}
              >
                <ArrowLeft />
              </Button>
            ) : desktop ? (
              <WindowChrome />
            ) : null}
          </div>
          <div className="flex min-w-0 flex-col items-center gap-1">
            <DialogTitle className="flex min-w-0 max-w-full items-center justify-center gap-2 text-body-lg font-medium">
              <span className="truncate" dir="auto">
                {current.name}
              </span>
              <HelperStatusPill
                status={status === "stopped" ? "failed" : status}
                stopped={status === "stopped"}
              />
            </DialogTitle>
            <p
              className="line-clamp-2 max-w-full text-center text-body-sm text-muted-foreground wrap-anywhere"
              dir="auto"
            >
              {current.task}
            </p>
          </div>
          <DialogClose
            aria-label={t`Close`}
            render={
              <Button variant="ghost" size="icon-sm" className="app-no-drag justify-self-end" />
            }
          >
            <XIcon />
          </DialogClose>
        </div>

        {!snapshot ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-body text-muted-foreground/80">
            {error ? (
              <div role="alert" className="flex flex-col items-center gap-3">
                <Trans>Could not load this thread.</Trans>
                <Button variant="outline" size="sm" onClick={retry}>
                  <Trans>Retry now</Trans>
                </Button>
              </div>
            ) : (
              <Spinner aria-label={t`Loading…`} />
            )}
          </div>
        ) : messages.length === 0 ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-body text-muted-foreground/80">
            {status === "running" ? (
              <Spinner aria-label={t`Loading…`} />
            ) : (
              <Trans>No messages.</Trans>
            )}
          </div>
        ) : (
          <div
            ref={transcriptRef}
            data-testid="helper-thread-transcript"
            onScroll={(event) => {
              followingEnd.current = transcriptIsNearEnd(event.currentTarget);
            }}
            className={`rk-scroll flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto py-5 md:py-6 ${TRANSCRIPT_CONTENT_PADDING}`}
          >
            {messages.map((message) => (
              <div key={message.id} data-message-id={message.id} className="flex justify-start">
                <div className={`w-fit min-w-0 ${bubbleFrameWidth(message.role)}`}>
                  <MessageView
                    artifactTarget={{ botId }}
                    message={message}
                    canAnswer={false}
                    canDismiss={false}
                    meId={undefined}
                    markedUnread={false}
                    onOpenBot={onOpenBot}
                    onOpenPeerMessages={onOpenPeerMessages}
                    onOpenSubagent={openNested}
                    readOnly
                    onAnswer={async () => undefined}
                    peerBot={peerBot}
                    onRefresh={async () => undefined}
                    onBotChanged={async () => undefined}
                    onAddRoutine={() => undefined}
                    voiceReady={false}
                    speaking={false}
                    callHoldsSpeaker={false}
                    onSpeak={() => undefined}
                    onOpenComputer={onOpenComputer}
                    onReleaseComputer={onReleaseComputer}
                    rpc={rpc}
                    showToolActivity
                    onReply={() => undefined}
                    onMarkUnread={() => undefined}
                    onReact={async () => undefined}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
