import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type {
  BotAvatarSet,
  ComputerReleaseReason,
  LoginFieldInput,
  MessageBlock,
  MessageReaction,
  ThreadMessage,
} from "@rakazo/contracts";
import type { ChildBotBlock, FoldedTranscript } from "@rakazo/core";
import {
  expandPeerReplies,
  groupVoiceChats,
  isPeerReceiptBlocks,
  liveActivityLine,
  liveMessageComposing,
  peerExchangeLines,
  projectBotMentions,
  projectMessageReactions,
  separateAskAnswers,
  timeSeparatorIds,
  unreadDividerMessageId,
  voiceChatHoldsMessage,
} from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { Button, cn, Spinner } from "@rakazo/ui-web";
import { ArrowDown } from "lucide-react";
import type { CSSProperties, RefObject } from "react";
import {
  Fragment,
  memo,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ActiveBotGlyph } from "../../../components/ai/CollaborationMarker";
import { VoiceChatCard } from "../../../components/call/VoiceChatCard";
import type { ActivityRunMeta } from "../../../components/messages/ActivityPanel";
import { LiveRunMonitorCard } from "../../../components/messages/ActivityPanel";
import type { HelperThreadTarget } from "../../../lib/chat/helper-thread";
import { messageHasVisibleBlocks } from "../../../lib/chat/tool-activity-view";
import { TRANSCRIPT_CONTENT_PADDING } from "../../../lib/chat/transcript-layout";
import {
  replyStartScrollTop,
  transcriptIsNearEnd,
  transcriptMovedDown,
} from "../../../lib/chat/transcript-scroll";
import type { ArtifactTarget } from "../../../lib/pages/artifact-open";
import { projectPageCards } from "../../../lib/pages/page-cards";
import type { createSpaceRpc } from "../../../lib/query/rpc";
import type { ImportSetupTarget } from "../bots/import-setup-card";
import { TimeSeparator, UnreadDivider } from "./chat-context";
import { MessageRunError } from "./message-run-error";
import { MessageView } from "./message-view";
import { QuoteSelectionButton, useTranscriptQuote } from "./quote-selection-button";

/** User bubbles stop at a readable line length; bot replies use the column, leaving room for the hover rail. */
export function bubbleFrameWidth(role: ThreadMessage["role"]) {
  return role === "user"
    ? "max-w-[min(84%,calc(100%_-_8rem),39rem)] [@media(hover:none)]:max-w-[min(84%,39rem)]"
    : "max-w-[min(96%,calc(100%_-_5rem))] [@media(hover:none)]:max-w-[96%]";
}

/** Rows drawn in the frame a chat opens; the rest mount right after without blocking input. */
const FIRST_FRAME_ROWS = 20;

export type TranscriptRunSummary = {
  id: string;
  botId?: string;
  modelId?: string | null;
  modelProvider?: string | null;
  costUsd?: number | null;
  startedAt?: string | null;
  status?: string;
  routineName?: string | null;
};

export const Transcript = memo(function Transcript({
  scrollRef,
  scrollRequest,
  onScrollRequestHandled,
  followRequest,
  artifactTarget,
  transcript,
  meId,
  showToolActivity,
  olderCursor,
  unreadAfterSeq,
  loadingOlder,
  answerableAskIds,
  dismissableAskIds,
  running,
  workingBots,
  workingRoutine,
  activeRun,
  threadRuns,
  failedRun,
  onRetryRun,
  retryingRun = false,
  userBubble,
  onStop,
  onRewind,
  onCallBack,
  onLoadOlder,
  onOpenBot,
  onAnswer,
  onReply,
  onMarkUnread,
  markedUnreadMessageId,
  onQuote,
  onQuoteShortcutChange,
  onReact,
  onJumpToMessage,
  onOpenPeerMessages,
  onOpenRoutine,
  onOpenSubagent,
  memberName,
  peerBot,
  onRefresh,
  onBotChanged,
  onAddRoutine,
  voiceReady,
  speakingMessageId,
  callHoldsSpeaker,
  onSpeak,
  onOpenComputer,
  onReleaseComputer,
  onOpenImportSetup,
  rpc,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  scrollRequest: { messageId: string; nonce: number } | null;
  onScrollRequestHandled: () => void;
  /** Changes when you send: the view moves to the end and follows the reply. */
  followRequest: number;
  artifactTarget: ArtifactTarget;
  transcript: FoldedTranscript<ThreadMessage>;
  meId?: string;
  showToolActivity: boolean;
  olderCursor: number | null;
  /** The seq read up to when this chat opened; null when nothing was unread. */
  unreadAfterSeq: number | null;
  loadingOlder: boolean;
  answerableAskIds: Set<string>;
  dismissableAskIds: Set<string>;
  running: boolean;
  workingBots: GroupAvatarMember[];
  workingRoutine?: string;
  activeRun?: TranscriptRunSummary | null;
  threadRuns?: readonly TranscriptRunSummary[];
  failedRun?: {
    id: string;
    botId?: string;
    error: string;
    resumable?: boolean;
  } | null;
  onRetryRun?: (runId: string) => void | Promise<void>;
  retryingRun?: boolean;
  /** Your bubbles take the bot's color in its own chat. */
  userBubble?: { background: string; foreground: string };
  onStop?: () => void;
  onRewind?: (input: {
    messageId: string;
    runId?: string;
    stepIndex: number;
    stepLabel?: string;
    stepDetail?: string;
  }) => Promise<void> | void;
  /** Calls the bot back from a missed call in the transcript. */
  onCallBack?: () => void;
  onLoadOlder: () => void | Promise<void>;
  onOpenBot: (botId: string) => void;
  onAnswer: (
    message: ThreadMessage,
    text: string,
    fields?: LoginFieldInput[],
    dismiss?: boolean,
    remember?: false,
  ) => Promise<void>;
  onReply: (message: ThreadMessage) => void;
  onMarkUnread: (message: ThreadMessage) => void;
  markedUnreadMessageId?: string;
  onQuote: (message: ThreadMessage, quote: string) => void;
  onQuoteShortcutChange?: (handler: (() => boolean) | null) => void;
  onReact: (message: ThreadMessage, reaction: MessageReaction) => Promise<void>;
  onJumpToMessage: (messageId: string) => void;
  onOpenPeerMessages: (peer: { peerBotId: string; peerBotName: string }) => void;
  /** Opens a routine from its chat row. */
  onOpenRoutine?: (name: string) => void;
  /** Opens a saved helper's read-only thread from its card. */
  onOpenSubagent?: (target: HelperThreadTarget) => void;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: (
    botId: string,
  ) => { name?: string; color: string; status?: string; avatarSet?: BotAvatarSet } | undefined;
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  voiceReady: boolean;
  speakingMessageId: string | null;
  callHoldsSpeaker: boolean;
  onSpeak: (message: ThreadMessage) => void;
  onOpenComputer: (botId?: string, takeControl?: boolean) => void;
  onReleaseComputer: (
    botId: string,
    runId: string | undefined,
    reason: ComputerReleaseReason,
  ) => Promise<void>;
  onOpenImportSetup?: (target: ImportSetupTarget) => void;
  rpc: ReturnType<typeof createSpaceRpc>;
}) {
  const { t } = useLingui();
  const [atEnd, setAtEnd] = useState(true);
  const following = useRef(true);
  // The messages loaded when the reader last sent: following stops at the first reply row after them.
  const messagesBeforeReply = useRef<ReadonlySet<string> | null>(null);
  // Where a reply's start is held. Its own scroll may land near the end and must not re-follow.
  const heldAt = useRef<number | null>(null);
  const jumpScrolling = useRef(false);
  const autoScrolling = useRef(false);
  const lastScrollTop = useRef<number | null>(null);
  // The fallback that ends a smooth jump to the latest message when no scroll reaches the end.
  const [autoScrollFallback, setAutoScrollFallback] = useState<{ ms: number } | null>(null);
  const jumpButtonRef = useRef<HTMLButtonElement>(null);
  const [expandedPeerMarkers, setExpandedPeerMarkers] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [liveStepsCache, setLiveStepsCache] = useState<
    ReadonlyMap<string, Extract<MessageBlock, { kind: "steps" }>>
  >(() => new Map());
  // A jump to a folded reply expands its marker; the scroll effect below then finds the row.
  useLayoutEffect(() => {
    const markerId = scrollRequest && transcript.markerOf.get(scrollRequest.messageId);
    if (!markerId) return;
    setExpandedPeerMarkers((expanded) =>
      expanded.has(markerId) ? expanded : new Set(expanded).add(markerId),
    );
  }, [scrollRequest, transcript]);
  const messages = useMemo(
    () => expandPeerReplies(transcript, expandedPeerMarkers),
    [transcript, expandedPeerMarkers],
  );
  useLayoutEffect(() => {
    setLiveStepsCache((previous) => {
      let updated: Map<string, Extract<MessageBlock, { kind: "steps" }>> | null = null;
      for (const message of messages) {
        if (!message.id.startsWith("progress:") || !message.runId) continue;
        const latestSteps = message.blocks.findLast(
          (block): block is Extract<MessageBlock, { kind: "steps" }> => block.kind === "steps",
        );
        if (!latestSteps) continue;
        if (previous.get(message.runId) !== latestSteps) {
          updated ??= new Map(previous);
          updated.set(message.runId, latestSteps);
        }
      }
      return updated ?? previous;
    });
  }, [messages]);
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  const committedMentions = useRef(new Map<string, ChildBotBlock[]>());
  const mentionView = useMemo(() => {
    const view = projectBotMentions(messages);
    for (const [id, mentions] of view.mentions) {
      const previous = committedMentions.current.get(id);
      if (
        previous?.length === mentions.length &&
        mentions.every((block, index) => block === previous[index])
      ) {
        view.mentions.set(id, previous);
      }
    }
    return view;
  }, [messages]);
  const committedPages = useRef<ReturnType<typeof projectPageCards> | null>(null);
  const pageView = useMemo(() => {
    const view = projectPageCards(mentionView.visibleMessages);
    const committed = committedPages.current;
    if (!committed) return view;
    for (const [id, pages] of view.pages) {
      const previous = committed.pages.get(id);
      if (
        previous?.length === pages.length &&
        pages.every((block, index) => block === previous[index])
      ) {
        view.pages.set(id, previous);
      }
    }
    if (committed.cardsKey === view.cardsKey) view.isSuperseded = committed.isSuperseded;
    return view;
  }, [mentionView]);
  // A progress tick rebuilds these views. The jump still reads the latest folds, without a new
  // callback that would rerender every memoized message.
  const foldViews = useRef({ mentionView, pageView });
  useLayoutEffect(() => {
    foldViews.current = { mentionView, pageView };
    committedMentions.current = mentionView.mentions;
    committedPages.current = pageView;
  }, [mentionView, pageView]);
  const jumpToMessage = useCallback(
    (messageId: string) => {
      const views = foldViews.current;
      const target = views.mentionView.foldedInto.get(messageId) ?? messageId;
      onJumpToMessage(views.pageView.foldedInto.get(target) ?? target);
    },
    [onJumpToMessage],
  );
  const reactionView = useMemo(() => projectMessageReactions(pageView.visibleMessages), [pageView]);
  const separateAnswers = useMemo(
    () => separateAskAnswers(reactionView.visibleMessages),
    [reactionView.visibleMessages],
  );
  const visibleReceipts = reactionView.visibleMessages.filter((message) =>
    messageHasVisibleBlocks(message.blocks, showToolActivity),
  );
  const exchanges = peerExchangeLines({ ...transcript, messages: visibleReceipts });
  const shownMessages = visibleReceipts.filter(
    (message) => !exchanges.lineOf.has(message.id) || exchanges.lines.has(message.id),
  );
  const separatorIds = timeSeparatorIds(shownMessages);
  const unreadDividerId = unreadDividerMessageId(shownMessages, unreadAfterSeq, olderCursor, meId);
  // Remounted per chat, so each opened chat paints its latest rows before the full history.
  const [tailOnly, setTailOnly] = useState(true);
  useEffect(() => startTransition(() => setTailOnly(false)), []);
  // A jump needs older rows, and must keep them after it clears its request.
  if (tailOnly && scrollRequest) setTailOnly(false);
  const showTail = tailOnly && !scrollRequest;
  const items = groupVoiceChats(reactionView.visibleMessages).filter(
    (item) =>
      item.kind === "voiceChat" || messageHasVisibleBlocks(item.message.blocks, showToolActivity),
  );
  const shownItems = showTail ? items.slice(-FIRST_FRAME_ROWS) : items;
  const failedMessageId = useMemo(() => {
    if (!failedRun) return undefined;
    for (let index = shownItems.length - 1; index >= 0; index -= 1) {
      const item = shownItems[index];
      if (
        item &&
        item.kind !== "voiceChat" &&
        item.message.role === "bot" &&
        item.message.runId === failedRun.id
      ) {
        return item.message.id;
      }
    }
    return undefined;
  }, [failedRun, shownItems]);
  const failedRunSpeaker = useMemo(() => {
    if (!failedRun?.botId) return undefined;
    const name = memberName?.(failedRun.botId);
    if (!name) return undefined;
    const bot = peerBot(failedRun.botId);
    return {
      botId: failedRun.botId,
      name,
      color: bot?.color,
      avatarSet: bot?.avatarSet,
    };
  }, [failedRun?.botId, memberName, peerBot]);
  const workingLabel =
    liveActivityLine(messages) ?? (workingRoutine ? t`Running ${workingRoutine}…` : t`Working…`);

  // A click, selection or small nudge that ends near the end leaves the reader at the
  // latest message, so new messages keep following; scrolling away beyond it does not.
  const followIfNearEnd = useCallback(() => {
    const element = scrollRef.current;
    if (
      element &&
      !jumpScrolling.current &&
      !isHeld(element, heldAt.current) &&
      transcriptIsNearEnd(element)
    ) {
      following.current = true;
    }
  }, [scrollRef]);

  const { quoteDraft, applyQuote } = useTranscriptQuote({
    messages,
    messageById,
    onQuote,
    onQuoteShortcutChange,
    onMouseUp: followIfNearEnd,
  });
  const snapToEnd = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    following.current = true;
    autoScrolling.current = false;
    setAtEnd(true);
    element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
  }, [scrollRef]);

  const jumpToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    following.current = true;
    messagesBeforeReply.current = null;
    heldAt.current = null;
    autoScrolling.current = !reducedMotion;
    setAtEnd(true);
    element.scrollTo({
      top: element.scrollHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    });
    // Fallback only: onScroll clears autoScrolling once near-end is reached.
    setAutoScrollFallback({ ms: reducedMotion ? 0 : 2_000 });
  }, [scrollRef]);
  useTimeout(
    () => {
      autoScrolling.current = false;
    },
    autoScrollFallback?.ms ?? null,
    autoScrollFallback,
  );

  const scrolledJump = useRef<number | null>(null);
  const [jumpScroll, setJumpScroll] = useState<number | null>(null);
  const endJumpScroll = useCallback(() => {
    jumpScrolling.current = false;
    setJumpScroll(null);
  }, []);
  useTimeout(endJumpScroll, jumpScroll === null ? null : 2_000, jumpScroll);
  // A jump scroll must win over follow-the-tail: unfollow inside the commit
  // that mounts the row so a live commit cannot cancel the animation, keep
  // retrying while the pinned window is still rendering, and suppress the
  // near-end follow re-arm only for the jump's own scroll events — scrollend
  // (or user input interrupting it, which also fires scrollend) ends the
  // suppression, with the timeout as fallback when no scroll happens.
  useLayoutEffect(() => {
    if (!scrollRequest || scrolledJump.current === scrollRequest.nonce) return;
    const element = scrollRef.current;
    const row = element?.querySelector(
      `[data-message-id="${CSS.escape(exchanges.lineOf.get(scrollRequest.messageId) ?? scrollRequest.messageId)}"]`,
    );
    if (!element || !row) return;
    scrolledJump.current = scrollRequest.nonce;
    following.current = false;
    messagesBeforeReply.current = null;
    autoScrolling.current = false;
    jumpScrolling.current = true;
    setJumpScroll(scrollRequest.nonce);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Streaming layout updates can interrupt a smooth jump before it reaches the row.
    row.scrollIntoView({ behavior: "auto", block: "center" });
    row.animate(
      reducedMotion
        ? [{ backgroundColor: "var(--muted)" }, { backgroundColor: "var(--muted)" }]
        : [
            { backgroundColor: "transparent" },
            { backgroundColor: "var(--muted)" },
            { backgroundColor: "transparent" },
          ],
      { duration: 1200 },
    );
    onScrollRequestHandled();
  }, [messages, scrollRequest, scrollRef, onScrollRequestHandled, exchanges.lineOf]);

  const followedRequest = useRef(followRequest);
  useLayoutEffect(() => {
    if (followedRequest.current === followRequest) return;
    followedRequest.current = followRequest;
    messagesBeforeReply.current = new Set(messages.map((message) => message.id));
    heldAt.current = null;
    snapToEnd();
  }, [followRequest, messages, snapToEnd]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const replyRow =
      element && following.current
        ? firstReplyRow(element, messages, messagesBeforeReply.current)
        : null;
    const replyTop =
      element && replyRow
        ? replyStartScrollTop(
            element,
            replyRow,
            Number.parseFloat(getComputedStyle(element).scrollPaddingTop) || 0,
          )
        : null;
    if (element && replyTop !== null) {
      // The reply no longer fits: hold its first line at the top and let the reader scroll on.
      following.current = false;
      messagesBeforeReply.current = null;
      autoScrolling.current = false;
      setAtEnd(false);
      element.scrollTo({ top: replyTop, behavior: "auto" });
      heldAt.current = element.scrollTop;
    } else if (following.current) {
      snapToEnd();
      // A finished reply that fit leaves later messages to follow to the end as before.
      if (replyRow && !running) messagesBeforeReply.current = null;
    }
    // Content can grow below a reader who is not following without any scroll event.
    else if (element) {
      setAtEnd(transcriptIsNearEnd(element) && !isHeld(element, heldAt.current));
    }
  }, [messages, running, showTail, scrollRef, snapToEnd, failedRun?.id]);

  useLayoutEffect(() => {
    const button = jumpButtonRef.current;
    if (atEnd && button && document.activeElement === button) {
      button.blur();
    }
  }, [atEnd]);

  const loadOlder = useCallback(() => {
    const wasFollowing = following.current;
    // Prepend must not race the messages-driven snap-to-end follow path.
    following.current = false;
    autoScrolling.current = false;
    const pending = onLoadOlder();
    if (!pending) return;
    return Promise.resolve(pending).catch((error) => {
      const element = scrollRef.current;
      if (wasFollowing && element && transcriptIsNearEnd(element)) {
        following.current = true;
        setAtEnd(true);
      }
      throw error;
    });
  }, [onLoadOlder, scrollRef]);

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        ref={scrollRef}
        data-testid="transcript"
        onPointerDown={(event) => {
          lastScrollTop.current = event.currentTarget.scrollTop;
          autoScrolling.current = false;
          following.current = false;
          messagesBeforeReply.current = null;
          heldAt.current = null;
        }}
        onTouchStart={(event) => {
          lastScrollTop.current = event.currentTarget.scrollTop;
          autoScrolling.current = false;
          following.current = false;
          messagesBeforeReply.current = null;
          heldAt.current = null;
        }}
        onScrollEnd={() => {
          followIfNearEnd();
          if (jumpScrolling.current) endJumpScroll();
        }}
        onWheel={(event) => {
          if (event.deltaY < 0) {
            lastScrollTop.current = event.currentTarget.scrollTop;
            autoScrolling.current = false;
            following.current = false;
            messagesBeforeReply.current = null;
            heldAt.current = null;
          }
        }}
        onScroll={(event) => {
          const scrolledDown = transcriptMovedDown(
            lastScrollTop.current,
            event.currentTarget.scrollTop,
          );
          lastScrollTop.current = event.currentTarget.scrollTop;
          const nearEnd = transcriptIsNearEnd(event.currentTarget);
          const held = isHeld(event.currentTarget, heldAt.current);
          setAtEnd(nearEnd && !held);
          // A jump scroll owns the viewport until its animation settles; its
          // own near-end crossings must not re-arm tail-following.
          if (jumpScrolling.current || held) return;
          if (nearEnd) {
            if (scrolledDown) following.current = true;
            if (autoScrolling.current) {
              autoScrolling.current = false;
              setAutoScrollFallback(null);
            }
          } else if (!autoScrolling.current) {
            following.current = false;
          }
        }}
        className={`rk-scroll isolate flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto scroll-pt-16 scroll-pb-7 pt-20 pb-12 md:pt-[84px] md:pb-13 ${TRANSCRIPT_CONTENT_PADDING}`}
        style={
          userBubble
            ? ({
                "--chat-user": userBubble.background,
                "--chat-user-foreground": userBubble.foreground,
              } as CSSProperties)
            : undefined
        }
      >
        {olderCursor != null && !showTail ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
            aria-label={t`Load earlier messages`}
            className="self-center text-muted-foreground"
          >
            {loadingOlder ? <Spinner aria-label={t`Loading…`} /> : null}
            {t`Load earlier messages`}
          </Button>
        ) : null}
        {shownItems.map((item) => {
          if (item.kind === "voiceChat") {
            return (
              <div key={item.key}>
                {item.messages[0] && separatorIds.has(item.messages[0].id) ? (
                  <TimeSeparator
                    createdAt={item.messages[0].createdAt}
                    locale={i18n.locale || "en"}
                  />
                ) : null}
                {voiceChatHoldsMessage(item, unreadDividerId) ? (
                  <UnreadDivider
                    afterSeparator={Boolean(
                      item.messages[0] && separatorIds.has(item.messages[0].id),
                    )}
                  />
                ) : null}
                <VoiceChatCard
                  group={item}
                  revealMessageId={scrollRequest?.messageId}
                  onCallBack={onCallBack}
                />
              </div>
            );
          }
          const message = item.message;
          const peerReceipt = isPeerReceiptBlocks(message.blocks);
          const messageReactions = reactionView.reactions.get(message.id);
          const msgRun = message.runId
            ? (threadRuns?.find((candidate) => candidate.id === message.runId) ??
              (activeRun?.id === message.runId ? activeRun : undefined))
            : message.id.startsWith("progress:")
              ? (activeRun ?? undefined)
              : undefined;
          const msgRunMeta: ActivityRunMeta | undefined =
            msgRun || (message.id.startsWith("progress:") && workingBots[0])
              ? {
                  runId: msgRun?.id ?? message.runId ?? undefined,
                  botId: message.botId ?? msgRun?.botId ?? workingBots[0]?.botId,
                  botName:
                    (message.botId
                      ? (memberName?.(message.botId) ?? peerBot(message.botId)?.name)
                      : undefined) ?? workingBots[0]?.name,
                  botColor:
                    (message.botId ? peerBot(message.botId)?.color : undefined) ??
                    workingBots[0]?.color,
                  modelId: msgRun?.modelId,
                  modelProvider: msgRun?.modelProvider,
                  costUsd: msgRun?.costUsd,
                  startedAt: msgRun?.startedAt,
                  status: msgRun?.status,
                  routineName: msgRun?.routineName ?? workingRoutine,
                }
              : undefined;
          return (
            <Fragment key={message.id}>
              {separatorIds.has(message.id) ? (
                <TimeSeparator createdAt={message.createdAt} locale={i18n.locale || "en"} />
              ) : null}
              {message.id === unreadDividerId ? (
                <UnreadDivider afterSeparator={separatorIds.has(message.id)} />
              ) : null}
              <div
                data-message-id={message.id}
                className={peerReceipt ? "relative" : "group/message relative hover:z-[1]"}
              >
                <div
                  className={
                    peerReceipt
                      ? undefined
                      : `relative flex ${message.role === "user" ? "justify-end" : "justify-start"}`
                  }
                >
                  <div
                    data-testid={peerReceipt ? undefined : "message-bubble-frame"}
                    className={
                      peerReceipt
                        ? undefined
                        : message.blocks.some(
                              (block) => block.kind === "ask" || block.kind === "mcp_approval",
                            ) &&
                            !message.blocks.some(
                              (block) => block.kind === "steps" || block.kind === "thinking",
                            ) &&
                            !(
                              showToolActivity &&
                              message.runId &&
                              liveStepsCache.has(message.runId)
                            )
                          ? "relative w-full min-w-0 max-w-xl"
                          : `relative ${
                              message.blocks.some(
                                (block) =>
                                  block.kind === "app_connect" ||
                                  block.kind === "page" ||
                                  block.kind === "computer" ||
                                  // The activity panel is a page-level block above the
                                  // reply, so the column, not the bubble, sets its width.
                                  block.kind === "thinking" ||
                                  block.kind === "steps" ||
                                  block.kind === "routine_event",
                              ) ||
                              (showToolActivity &&
                                message.runId &&
                                liveStepsCache.has(message.runId)) ||
                              pageView.pages.has(message.id)
                                ? "w-full"
                                : "w-fit"
                            } min-w-0 ${bubbleFrameWidth(message.role)}`
                    }
                  >
                    <MessageView
                      artifactTarget={artifactTarget}
                      message={message}
                      separateAnswers={separateAnswers.get(message.id)}
                      meId={meId}
                      markedUnread={message.id === markedUnreadMessageId}
                      mentions={mentionView.mentions.get(message.id)}
                      pages={pageView.pages.get(message.id)}
                      isPageSuperseded={pageView.isSuperseded}
                      canAnswer={answerableAskIds.has(message.id)}
                      canDismiss={dismissableAskIds.has(message.id)}
                      onOpenBot={onOpenBot}
                      onOpenPeerMessages={onOpenPeerMessages}
                      onOpenRoutine={onOpenRoutine}
                      onOpenSubagent={onOpenSubagent}
                      peerExchange={exchanges.lines.get(message.id)}
                      onAnswer={onAnswer}
                      speakerName={
                        peerReceipt
                          ? undefined
                          : message.role === "bot"
                            ? memberName?.(message.botId)
                            : undefined
                      }
                      memberName={memberName}
                      peerBot={peerBot}
                      replyParent={
                        message.replyToMessageId
                          ? messageById.get(message.replyToMessageId)
                          : undefined
                      }
                      onJumpToMessage={jumpToMessage}
                      onRefresh={onRefresh}
                      onBotChanged={onBotChanged}
                      onAddRoutine={onAddRoutine}
                      voiceReady={voiceReady}
                      speaking={speakingMessageId === message.id}
                      callHoldsSpeaker={callHoldsSpeaker}
                      onSpeak={onSpeak}
                      onOpenComputer={onOpenComputer}
                      onReleaseComputer={onReleaseComputer}
                      onOpenImportSetup={onOpenImportSetup}
                      rpc={rpc}
                      showToolActivity={showToolActivity}
                      runMeta={msgRunMeta}
                      cachedSteps={message.runId ? liveStepsCache.get(message.runId) : undefined}
                      onStop={onStop}
                      onRewind={onRewind}
                      onReply={onReply}
                      onMarkUnread={onMarkUnread}
                      onReact={onReact}
                    />
                    {failedRun && failedMessageId === message.id && onRetryRun ? (
                      <MessageRunError
                        attachedToMessage
                        error={failedRun.error}
                        resumable={failedRun.resumable}
                        retrying={retryingRun}
                        onRetry={() => void onRetryRun(failedRun.id)}
                      />
                    ) : null}
                  </div>
                </div>
                {!peerReceipt && messageReactions ? (
                  <div
                    data-testid="message-reactions"
                    className={cn(
                      "mt-1 flex flex-wrap gap-1",
                      message.role === "user" && "justify-end",
                    )}
                  >
                    {[...messageReactions].map(([emoji, count]) => (
                      <span
                        key={emoji}
                        className="rounded-full border border-border bg-muted px-2 py-0.5 text-label"
                      >
                        {emoji}
                        {count > 1 ? ` ${count}` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </Fragment>
          );
        })}
        {failedRun && !failedMessageId && onRetryRun ? (
          <div data-testid="standalone-run-error" className={`relative flex justify-start`}>
            <div className={`relative w-fit min-w-0 ${bubbleFrameWidth("bot")}`}>
              <MessageRunError
                error={failedRun.error}
                resumable={failedRun.resumable}
                retrying={retryingRun}
                onRetry={() => void onRetryRun(failedRun.id)}
                speaker={failedRunSpeaker}
              />
            </div>
          </div>
        ) : null}
        {running &&
        !messages.some(
          (message) => message.id.startsWith("progress:") && liveMessageComposing(message.blocks),
        ) ? (
          showToolActivity ? (
            !messages.some(
              (message) =>
                message.id.startsWith("progress:") &&
                message.blocks.some((block) => block.kind === "steps" || block.kind === "thinking"),
            ) ? (
              <LiveRunMonitorCard
                label={workingLabel}
                runMeta={{
                  runId: activeRun?.id,
                  botId: activeRun?.botId ?? workingBots[0]?.botId,
                  botName: workingBots[0]?.name,
                  botColor: workingBots[0]?.color,
                  modelId: activeRun?.modelId,
                  modelProvider: activeRun?.modelProvider,
                  costUsd: activeRun?.costUsd,
                  startedAt: activeRun?.startedAt,
                  status: activeRun?.status ?? "running",
                  routineName: activeRun?.routineName ?? workingRoutine,
                }}
                onStop={onStop}
              />
            ) : null
          ) : (
            <ActiveBotGlyph bots={workingBots} label={workingLabel} />
          )
        ) : null}
      </div>
      {quoteDraft ? <QuoteSelectionButton range={quoteDraft.range} onQuote={applyQuote} /> : null}
      <Button
        ref={jumpButtonRef}
        variant="floating"
        size="icon-lg"
        aria-label={t`Jump to latest`}
        aria-hidden={atEnd}
        tabIndex={atEnd ? -1 : 0}
        onClick={jumpToLatest}
        className={`absolute bottom-11 left-1/2 z-20 -translate-x-1/2 shadow-md transition-[opacity,transform,background-color] duration-200 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none ${
          atEnd ? "pointer-events-none translate-y-2 opacity-0" : "translate-y-0 opacity-100"
        }`}
      >
        <ArrowDown strokeWidth={1.8} className="size-[17px]" />
      </Button>
    </div>
  );
});

/** The first reply row shown after the last of the messages in `before`; older history never counts. */
function firstReplyRow(
  element: HTMLElement,
  messages: ThreadMessage[],
  before: ReadonlySet<string> | null,
): HTMLElement | null {
  if (!before) return null;
  const start = messages.findLastIndex((message) => before.has(message.id)) + 1;
  for (const message of messages.slice(start)) {
    if (message.role === "user") continue;
    const row = element.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(message.id)}"]`);
    if (row) return row;
  }
  return null;
}

function isHeld(element: HTMLElement, heldAt: number | null): boolean {
  return heldAt !== null && Math.abs(element.scrollTop - heldAt) < 1;
}
