import { useLingui } from "@lingui/react/macro";
import type {
  Bot,
  ComputerStatus,
  DriveFile,
  LoginFieldInput,
  Me,
  MessageReaction,
  ThreadMessage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { attachmentMaxCount, attachmentSizeLabel, fileUploadMaxBytes } from "@rakazo/contracts";
import type { ComposerMention } from "@rakazo/core";
import {
  applyThreadSendReceipt,
  attachmentsForThread,
  inferAttachmentMimeType,
  isImageInputConfirmation,
  newClientId,
  resolveComposerSendPlan,
} from "@rakazo/core";
import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  forgetSeenRunErrorId,
  readSeenRunErrorIds,
  rememberSeenRunErrorId,
} from "../../../lib/chat/run-error-storage";
import { setComposerUnsavedWork } from "../../../lib/composer/composer-draft";
import { scheduleFocusPrompt } from "../../../lib/composer/focus-prompt";
import {
  revokePendingAttachmentPreviews,
  usePendingAttachmentPreviewCleanup,
} from "../../../lib/composer/pending-attachments";
import { canPrepareImage } from "../../../lib/composer/prepare-image";
import type { WebOutboxAttachment, WebSendAttempt } from "../../../lib/composer/send-outbox";
import {
  discardWebSendAttempt,
  discardWebThreadOutbox,
  enqueueWebSend,
  hasUnsentWebSends,
  retryWebSendAttempt,
  subscribeWebOutboxDelivered,
} from "../../../lib/composer/send-outbox";
import { useWebOutbox } from "../../../lib/composer/use-send-outbox";
import type { PageSession } from "../../../lib/pages/pages";
import { requestBrowserNotificationPermission } from "../../../lib/platform/browser-notifications";
import { createSpaceRpc, selectedSpaceId } from "../../../lib/query/rpc";
import { clearActiveThreadRuns, threadRunError } from "../../../lib/query/thread-events";
import { errorText } from "../../../lib/query/user-error";
import type { PendingAttachment } from "../chat/chat-shared";
import { previewMessageText } from "../chat/chat-shared";
import type { useShellNavigation } from "../use-shell-navigation";

type ThreadRefresh = RefObject<(id: string) => Promise<ThreadSnapshot>>;

/**
 * What the composer sends and the chat actions beside it: attachments, replies, send, stop,
 * answers, reactions, and the errors they leave.
 */
export function useComposerActions({
  rpc,
  pageSession,
  userId,
  spaceId,
  activeId,
  inGroup,
  groupId,
  activeBotId,
  activeGroupId,
  botsRef,
  bootstrapMe,
  activeSnapshot,
  navigate,
  refreshBots,
  refreshThreadRef,
  refreshGroupThreadRef,
  updateSnapshot,
  terminalRunReceipts,
  computerRef,
  commitComputer,
  clearReadBoundary,
  flushPendingBrowserNotifications,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  /** The chat's open page, whose card a message sent from it replies to. */
  pageSession: PageSession;
  /** The signed-in account the outbox belongs to; a worker page without one sends as `local`. */
  userId?: string;
  /** The Space the queued sends deliver into; defaults to the selected Space. */
  spaceId?: string | null;
  activeId: string | undefined;
  inGroup: boolean;
  groupId: string | undefined;
  activeBotId: RefObject<string | undefined>;
  activeGroupId: RefObject<string | undefined>;
  botsRef: RefObject<Bot[]>;
  bootstrapMe: Me | null | undefined;
  activeSnapshot: ThreadSnapshot | null;
  navigate: ReturnType<typeof useShellNavigation>["navigate"];
  refreshBots: () => Promise<void>;
  refreshThreadRef: ThreadRefresh;
  refreshGroupThreadRef: ThreadRefresh;
  updateSnapshot: (update: (prev: ThreadSnapshot | null) => ThreadSnapshot | null) => void;
  terminalRunReceipts: RefObject<Set<string>>;
  computerRef: RefObject<ComputerStatus | null>;
  commitComputer: (next: ComputerStatus | null) => void;
  clearReadBoundary: () => void;
  flushPendingBrowserNotifications: () => void;
}) {
  const { t } = useLingui();
  const outboxUserId = userId ?? "local";
  const outboxSpaceId = spaceId === undefined ? selectedSpaceId() : spaceId;
  const activeThreadKey = inGroup ? groupId : activeId;
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  usePendingAttachmentPreviewCleanup(pendingAttachments);
  const [replyTarget, setReplyTarget] = useState<ThreadMessage | null>(null);
  const [replyQuote, setReplyQuote] = useState<string | null>(null);
  // Only stopping a run blocks the composer; sending never does, so messages queue behind.
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const [sentCount, setSentCount] = useState(0);
  const echoedSeqs = useMemo(() => {
    const seqs = new Set<number>();
    for (const message of activeSnapshot?.messages ?? [])
      if (message.role === "user" && typeof message.seq === "number") seqs.add(message.seq);
    return seqs;
  }, [activeSnapshot?.messages]);
  const pendingSends = useWebOutbox({
    threadKey: activeThreadKey,
    userId: outboxUserId,
    spaceId: outboxSpaceId,
    echoedSeqs,
    rpcForSpace: (targetSpaceId) =>
      targetSpaceId === outboxSpaceId ? rpc : createSpaceRpc(targetSpaceId),
  });
  useEffect(() => {
    setComposerUnsavedWork({
      sending: stopping || hasUnsentWebSends(),
      attachments: pendingAttachments.length > 0,
    });
    return () => setComposerUnsavedWork({ sending: false, attachments: false });
  }, [stopping, pendingSends.length, pendingAttachments.length]);
  const [sendFailure, setSendFailure] = useState<{
    message: string;
    imageConfirmation: boolean;
  } | null>(null);
  // Counts real composer edits so a late rejection cannot confirm a newer draft.
  const draftEdits = useRef(0);
  const clearImageConfirmation = useCallback(() => {
    draftEdits.current += 1;
    setSendFailure((current) => (current?.imageConfirmation ? null : current));
  }, []);
  const imageConfirmation = sendFailure?.imageConfirmation === true;
  const sendError = sendFailure?.message ?? null;
  const setSendError = useCallback((message: string | null) => {
    setSendFailure(message === null ? null : { message, imageConfirmation: false });
  }, []);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dismissedRunErrorIds, setDismissedRunErrorIds] =
    useState<ReadonlySet<string>>(readSeenRunErrorIds);
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);
  const retryingRunIdRef = useRef<string | null>(null);
  const focusPromptAbortRef = useRef<AbortController | null>(null);
  const focusPromptBotIdRef = useRef<string | null>(null);

  const activePendingAttachments = useMemo(
    () => attachmentsForThread(pendingAttachments, inGroup ? groupId : activeId),
    [activeId, groupId, inGroup, pendingAttachments],
  );
  // Keep the armed reply even when its parent leaves the loaded page: the
  // server resolves a paged-out target and degrades a deleted one to a plain
  // reply instead of failing the send.
  const activeReplyTarget = replyTarget;
  const activeReplyQuote = replyTarget ? replyQuote : null;
  // The armed reply as one value: a newer pick of the same message with a
  // different excerpt is still a newer pick.
  const armedReply = useRef({ target: activeReplyTarget, quote: activeReplyQuote });
  armedReply.current = { target: activeReplyTarget, quote: activeReplyQuote };
  const clearReply = useCallback(() => {
    setReplyTarget(null);
    setReplyQuote(null);
  }, []);
  /** Clears the reply a send carried; one picked while it was in flight stays armed. */
  const clearSentReply = useCallback((sent: ThreadMessage | null, sentQuote: string | null) => {
    if (armedReply.current.target === sent && armedReply.current.quote === sentQuote) {
      setReplyTarget(null);
      setReplyQuote(null);
    }
  }, []);
  const runError = threadRunError(activeSnapshot, dismissedRunErrorIds);
  const displayedRunError = !sendError ? runError : null;
  const displayedRunErrorId = displayedRunError ? (activeSnapshot?.run?.id ?? null) : null;
  const handleRunErrorPresented = useCallback((runId: string) => {
    rememberSeenRunErrorId(runId);
  }, []);
  const activeRunId = activeSnapshot?.run?.id;
  const activeRunStatus = activeSnapshot?.run?.status;
  useEffect(() => {
    if (!activeRunId || !activeRunStatus || activeRunStatus === "failed") return;
    forgetSeenRunErrorId(activeRunId);
    setDismissedRunErrorIds((current) => {
      if (!current.has(activeRunId)) return current;
      const next = new Set(current);
      next.delete(activeRunId);
      return next;
    });
  }, [activeRunId, activeRunStatus]);

  function cancelFocusPrompt() {
    focusPromptAbortRef.current?.abort();
    focusPromptAbortRef.current = null;
    focusPromptBotIdRef.current = null;
  }

  /** Starts a new bot's onboarding, then offers its focus card unless the user engages first. */
  async function startFocusPrompt(botId: string, immediate: boolean) {
    // Register cancellation before awaiting start so leaving the bot during
    // startup cannot miss the abort and still schedule a late focus card.
    cancelFocusPrompt();
    const controller = new AbortController();
    focusPromptAbortRef.current = controller;
    focusPromptBotIdRef.current = botId;
    const started = await rpc.onboarding
      .start({ botId })
      .then(() => true)
      .catch(() => false);
    if (!started || controller.signal.aborted || focusPromptBotIdRef.current !== botId) {
      if (focusPromptAbortRef.current === controller) {
        focusPromptAbortRef.current = null;
        focusPromptBotIdRef.current = null;
      }
      return;
    }
    void scheduleFocusPrompt({
      immediate,
      signal: controller.signal,
      shouldSkip: () => hasUnsentWebSends(botId) || stoppingRef.current,
      prompt: async () => {
        if (focusPromptBotIdRef.current !== botId || activeBotId.current !== botId) return;
        await rpc.onboarding.promptFocus({ botId }).catch(() => undefined);
      },
    }).finally(() => {
      if (focusPromptAbortRef.current === controller) {
        focusPromptAbortRef.current = null;
        focusPromptBotIdRef.current = null;
      }
    });
  }

  useEffect(() => {
    if (focusPromptBotIdRef.current && focusPromptBotIdRef.current !== activeId) {
      cancelFocusPrompt();
    }
  }, [activeId]);

  useEffect(() => () => cancelFocusPrompt(), []);

  // Switching chats keeps other chats' pending attachments with their previews;
  // only the open chat's files are shown and sent (activePendingAttachments).
  useEffect(() => {
    clearReply();
    setAttachmentNotice(null);
    setSendError(null);
  }, [activeId, clearReply, groupId, inGroup]);

  const answerMessage = useCallback(
    async (
      message: ThreadMessage,
      text: string,
      fields?: LoginFieldInput[],
      dismiss?: boolean,
      remember?: false,
    ) => {
      const botId = activeBotId.current;
      const groupId = activeGroupId.current;
      if (!botId && !groupId) return;
      clearReadBoundary();
      await rpc.threads.answer({
        ...(groupId ? { groupId } : { botId: botId! }),
        runId: message.runId ?? "",
        messageId: message.id,
        answer: text,
        ...(fields ? { fields } : {}),
        ...(remember === false ? { remember } : {}),
        ...(dismiss ? { dismiss: true as const } : {}),
      });
      // The answer is saved; live events can reconcile a failed refresh.
      try {
        if (groupId && activeGroupId.current === groupId) {
          await refreshGroupThreadRef.current(groupId);
        } else if (botId && activeBotId.current === botId) {
          await refreshThreadRef.current(botId);
        }
      } catch {}
    },
    [],
  );
  const reactToMessage = useCallback(
    async (message: ThreadMessage, reaction: MessageReaction) => {
      const botId = activeBotId.current;
      const groupId = activeGroupId.current;
      if (!botId && !groupId) return;
      try {
        const result = await rpc.threads.react({
          ...(groupId ? { groupId } : { botId: botId! }),
          messageId: message.id,
          reaction,
          clientNonce: newClientId(),
        });
        if (result.runIds?.length) {
          // The reaction is saved; a failed refresh is caught up by live events.
          try {
            if (groupId && activeGroupId.current === groupId) {
              await refreshGroupThreadRef.current(groupId);
            } else if (botId && activeBotId.current === botId) {
              await refreshThreadRef.current(botId);
            }
          } catch {}
        }
      } catch (error) {
        const stillHere = groupId
          ? activeGroupId.current === groupId
          : activeBotId.current === botId;
        if (!stillHere) return;
        setSendError(errorText(error, t`Could not update reaction`));
      }
    },
    [t],
  );
  const onAttachmentPick = useCallback(
    (files: FileList | readonly File[] | null) => {
      const threadKey = activeGroupId.current ?? activeBotId.current;
      if (!threadKey || !files?.length) return false;
      const ATTACHMENT_MAX_COUNT = attachmentMaxCount(bootstrapMe);
      const maxFileBytes = fileUploadMaxBytes(bootstrapMe);
      const existing = attachmentsForThread(pendingAttachments, threadKey);
      const next: PendingAttachment[] = [];
      const skipped: string[] = [];
      for (const file of Array.from(files)) {
        if (existing.length + next.length >= ATTACHMENT_MAX_COUNT) {
          skipped.push(t`${file.name} (max ${ATTACHMENT_MAX_COUNT} attachments)`);
          continue;
        }
        // Raster photos get a chance to shrink before server-side size validation.
        if (file.size > maxFileBytes && !canPrepareImage(file)) {
          skipped.push(t`${file.name} (over ${attachmentSizeLabel(maxFileBytes)})`);
          continue;
        }
        const mimeType = inferAttachmentMimeType(file.name, file.type);
        if (!mimeType) {
          skipped.push(file.name);
          continue;
        }
        next.push({
          // A client id, not file metadata: two picks of equal metadata are separate attachments.
          id: newClientId(),
          threadKey,
          file,
          previewUrl: mimeType.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        });
      }
      if (next.length) setPendingAttachments((current) => [...current, ...next]);
      setAttachmentNotice(skipped.length ? t`Skipped ${skipped.join(", ")}` : null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return next.length > 0;
    },
    [pendingAttachments, bootstrapMe, t],
  );
  /** Attaches a file already in the Space Drive, which is sent by its id instead of uploading. */
  const onDriveFilePick = useCallback(
    (file: DriveFile) => {
      const threadKey = activeGroupId.current ?? activeBotId.current;
      if (!threadKey) return false;
      const ATTACHMENT_MAX_COUNT = attachmentMaxCount(bootstrapMe);
      const existing = attachmentsForThread(pendingAttachments, threadKey);
      if (existing.length >= ATTACHMENT_MAX_COUNT) {
        setAttachmentNotice(t`Skipped ${file.name} (max ${ATTACHMENT_MAX_COUNT} attachments)`);
        return false;
      }
      setPendingAttachments((current) => [
        ...current,
        {
          id: newClientId(),
          threadKey,
          driveFile: {
            artifactId: file.id,
            name: file.name,
            mimeType: file.mimeType,
            size: file.size,
          },
        },
      ]);
      setAttachmentNotice(null);
      return true;
    },
    [pendingAttachments, bootstrapMe, t],
  );
  const removeAttachment = useCallback((attachment: PendingAttachment) => {
    revokePendingAttachmentPreviews([attachment]);
    setPendingAttachments((current) => current.filter((item) => item.id !== attachment.id));
  }, []);
  /** A deleted chat's files can never be sent: drop them and release their previews. */
  const discardThreadAttachments = useCallback((threadKey: string) => {
    setPendingAttachments((current) => {
      const discarded = attachmentsForThread(current, threadKey);
      if (!discarded.length) return current;
      revokePendingAttachmentPreviews(discarded);
      return current.filter((attachment) => !discarded.includes(attachment));
    });
    // Sends still waiting for that chat go with it.
    discardWebThreadOutbox(threadKey);
  }, []);
  // The delivery arrives outside React: read everything through refs so the subscription
  // stays one for the shell's life and still sees the open chat and Space.
  const deliveredRef = useRef<(attempt: WebSendAttempt) => void>(() => undefined);
  deliveredRef.current = (attempt) => {
    if (attempt.scope.userId !== outboxUserId) return;
    const payload = attempt.payload;
    if (payload.initialBotTarget && focusPromptBotIdRef.current === payload.initialBotTarget) {
      cancelFocusPrompt();
    }
    // The chat that queued it may be open in another Space: this one does not refresh.
    if (attempt.scope.spaceId !== outboxSpaceId) return;
    const acceptedRun = attempt.acceptedRun;
    if (acceptedRun && payload.botTarget && activeBotId.current === payload.botTarget) {
      const botId = payload.botTarget;
      updateSnapshot((current) =>
        applyThreadSendReceipt(
          current,
          { botId, runId: acceptedRun.runId, taskId: acceptedRun.taskId },
          terminalRunReceipts.current,
        ),
      );
    }
    // Refresh sidebar status even when a bot→group reroute navigates away below.
    void refreshBots().catch(() => undefined);
    if (payload.reroutedToGroup && payload.groupTarget) {
      navigate(`/app/g/${payload.groupTarget}`);
      return;
    }
    if (payload.groupTarget && activeGroupId.current === payload.groupTarget) {
      setAttachmentNotice(null);
      void refreshGroupThreadRef.current(payload.groupTarget).catch(() => undefined);
    } else if (payload.botTarget && activeBotId.current === payload.botTarget) {
      setAttachmentNotice(null);
      void refreshThreadRef.current(payload.botTarget).catch(() => undefined);
    }
  };
  useEffect(() => subscribeWebOutboxDelivered((attempt) => deliveredRef.current(attempt)), []);
  const sendMessage = useCallback(
    async (
      draft: string,
      mentions: ComposerMention[],
      clientNonce: string,
      imageHandling?: "file",
    ) => {
      const initialBotTarget = activeBotId.current;
      const initialGroupTarget = activeGroupId.current;
      if (!initialBotTarget && !initialGroupTarget) return false;
      const editsAtSend = draftEdits.current;
      // The reply this send carries, read from the ref so a callback that outlived
      // a re-pick of the same message still carries the armed one; a reply picked
      // after this point is for the next message.
      const { target: replyAtSend, quote: replyQuoteAtSend } = armedReply.current;
      const originThreadKey = initialGroupTarget ?? initialBotTarget;
      const attachments = attachmentsForThread(pendingAttachments, originThreadKey);
      const plan = resolveComposerSendPlan({
        text: draft,
        mentions,
        hasAttachments: attachments.length > 0,
      });
      if (plan.isNoOp) return false;
      const reroutedToGroup = Boolean(
        plan.rerouteGroupId && plan.rerouteGroupId !== initialGroupTarget,
      );
      const groupTarget = plan.rerouteGroupId ?? initialGroupTarget;
      const botTarget = reroutedToGroup ? undefined : initialBotTarget;
      // A group mention with nothing to send only opens that group.
      if (!plan.shouldSend && !plan.shouldRunRoutines) {
        if (!reroutedToGroup || !groupTarget) return false;
        // Only a real engagement answers the bot's focus card.
        if (initialBotTarget && focusPromptBotIdRef.current === initialBotTarget) {
          cancelFocusPrompt();
        }
        clearSentReply(replyAtSend, replyQuoteAtSend);
        revokePendingAttachmentPreviews(attachments);
        setPendingAttachments((current) =>
          current.filter((attachment) => !attachments.includes(attachment)),
        );
        setAttachmentNotice(null);
        clearReadBoundary();
        setSentCount((count) => count + 1);
        navigate(`/app/g/${groupTarget}`);
        return true;
      }
      if (
        plan.shouldSend &&
        (groupTarget || botsRef.current.find((bot) => bot.id === botTarget)?.notifyOnFinish)
      ) {
        const permissionRequest = requestBrowserNotificationPermission();
        if (permissionRequest) void permissionRequest.then(flushPendingBrowserNotifications);
      }
      // The open page rides only on text this chat sends, never on a group or routine-only send.
      const fromPage =
        plan.shouldSend && !reroutedToGroup
          ? pageSession.send(plan.trimmed, activeSnapshot?.messages ?? [], replyAtSend?.id)
          : { text: plan.trimmed, replyToMessageId: undefined };
      const trimmed = fromPage.text.trim();
      const replyToMessageId = fromPage.replyToMessageId;
      const outboxAttachments: WebOutboxAttachment[] = [];
      for (const pending of attachments) {
        if (pending.driveFile) {
          outboxAttachments.push({ kind: "drive", id: pending.id, driveFile: pending.driveFile });
          continue;
        }
        const file = pending.file!;
        const mimeType = inferAttachmentMimeType(file.name, file.type);
        if (!mimeType) {
          setSendError(t`Unsupported file type: ${file.name}`);
          return false;
        }
        outboxAttachments.push({
          kind: "file",
          id: pending.id,
          name: file.name,
          mimeType,
          size: file.size,
          file,
          // Scoped to the target, so a retry rerouted to a group uploads afresh instead of
          // replaying another chat's artifact.
          uploadNonce: `attachment:${groupTarget ?? botTarget}:${pending.id}`,
          ...(pending.previewUrl ? { previewUrl: pending.previewUrl } : {}),
        });
      }
      const pageCard = replyToMessageId
        ? activeSnapshot?.messages.find((message) => message.id === replyToMessageId)
        : undefined;
      const replyPreview = reroutedToGroup
        ? null
        : pageCard
          ? previewMessageText(pageCard)
          : (replyQuoteAtSend ?? (replyAtSend ? previewMessageText(replyAtSend) : null));
      try {
        // The outbox sends it: offline, a full server or a reload no longer loses the words.
        enqueueWebSend({
          clientNonce,
          scope: { userId: outboxUserId, spaceId: outboxSpaceId },
          payload: {
            originThreadKey: originThreadKey!,
            // The page marker added to the words is not the user's draft.
            displayText: fromPage.text === plan.trimmed ? draft : fromPage.text,
            replyPreview,
            initialBotTarget,
            botTarget,
            groupTarget,
            reroutedToGroup,
            plan,
            trimmed,
            replyToMessageId: reroutedToGroup ? undefined : (replyToMessageId ?? replyAtSend?.id),
            replyQuote:
              reroutedToGroup || replyToMessageId ? undefined : (replyQuoteAtSend ?? undefined),
            fromPage: !reroutedToGroup && replyToMessageId ? true : undefined,
            attachments: outboxAttachments,
          },
          imageHandling,
        });
      } catch (error) {
        // A refused enqueue sent nothing, so the words, files and reply stay in the composer.
        setSendFailure({
          message: errorText(error, t`Failed to send message`),
          imageConfirmation: draftEdits.current === editsAtSend && isImageInputConfirmation(error),
        });
        return false;
      }
      setSendError(null);
      setAttachmentNotice(null);
      clearReadBoundary();
      setSentCount((count) => count + 1);
      clearSentReply(replyAtSend, replyQuoteAtSend);
      // The queue owns these files and their previews now: drop them without releasing them.
      setPendingAttachments((current) =>
        current.filter((attachment) => !attachments.includes(attachment)),
      );
      return true;
    },
    [
      activeSnapshot?.messages,
      pageSession,
      clearSentReply,
      flushPendingBrowserNotifications,
      navigate,
      outboxSpaceId,
      outboxUserId,
      pendingAttachments,
      t,
    ],
  );
  const stopRun = useCallback(async () => {
    if (stopping) return;
    stoppingRef.current = true;
    setStopping(true);
    try {
      const botTarget = activeBotId.current;
      const groupTarget = activeGroupId.current;
      if (groupTarget) {
        setSendError(null);
        try {
          await rpc.threads.stop({ groupId: groupTarget });
        } catch (error) {
          if (activeGroupId.current === groupTarget) {
            setSendError(errorText(error, t`Failed to stop`));
          }
          return;
        }
        // Clear run UI ahead of the run.cancelled event so refresh races with in-flight gets.
        if (activeGroupId.current === groupTarget) {
          updateSnapshot((prev) =>
            prev && prev.groupId === groupTarget ? clearActiveThreadRuns(prev) : prev,
          );
        }
        await refreshGroupThreadRef.current(groupTarget).catch(() => undefined);
        return;
      }
      if (!botTarget) return;
      setSendError(null);
      try {
        await rpc.threads.stop({ botId: botTarget });
      } catch (error) {
        if (activeBotId.current === botTarget) {
          setSendError(errorText(error, t`Failed to stop`));
        }
        return;
      }
      // Clear local run/busy immediately rather than waiting for run.cancelled so a
      // superseded in-flight refresh (older cursor) cannot leave Stop enabled / Take control
      // blocked while the API is already idle.
      if (activeBotId.current === botTarget) {
        updateSnapshot((prev) =>
          !prev || (prev.botId !== botTarget && prev.botId) ? prev : clearActiveThreadRuns(prev),
        );
        const currentComputer = computerRef.current;
        if (currentComputer?.busyBotName) {
          commitComputer({ ...currentComputer, busyBotName: null });
        }
      }
      await refreshThreadRef.current(botTarget).catch(() => undefined);
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  }, [stopping, t]);

  const rewindRun = useCallback(
    async (input: {
      messageId: string;
      runId?: string;
      stepIndex: number;
      stepLabel?: string;
      stepDetail?: string;
    }) => {
      const botTarget = activeBotId.current;
      const groupTarget = activeGroupId.current;
      if (!botTarget && !groupTarget) return;
      setSendError(null);
      try {
        await rpc.threads.rewind({
          ...(groupTarget ? { groupId: groupTarget } : { botId: botTarget! }),
          messageId: input.messageId,
          ...(input.runId ? { runId: input.runId } : {}),
          stepIndex: input.stepIndex,
          ...(input.stepLabel ? { stepLabel: input.stepLabel } : {}),
          ...(input.stepDetail ? { stepDetail: input.stepDetail } : {}),
          clientNonce: newClientId(),
        });
      } catch (error) {
        if (activeGroupId.current === groupTarget && activeBotId.current === botTarget) {
          setSendError(errorText(error, t`Failed to rewind`));
        }
        return;
      }
      if (groupTarget) {
        await refreshGroupThreadRef.current(groupTarget).catch(() => undefined);
      } else if (botTarget) {
        await refreshThreadRef.current(botTarget).catch(() => undefined);
      }
    },
    [t],
  );

  const retryRun = useCallback(
    async (runId: string) => {
      if (retryingRunIdRef.current) return;
      const botTarget = activeBotId.current;
      const groupTarget = activeGroupId.current;
      if (!botTarget && !groupTarget) return;
      retryingRunIdRef.current = runId;
      setRetryingRunId(runId);
      setSendError(null);
      try {
        await rpc.threads.retry({
          ...(groupTarget ? { groupId: groupTarget } : { botId: botTarget! }),
          runId,
        });
      } catch (error) {
        if (activeGroupId.current === groupTarget && activeBotId.current === botTarget) {
          setSendError(errorText(error, t`Failed to retry`));
        }
        return;
      } finally {
        retryingRunIdRef.current = null;
        setRetryingRunId(null);
      }
      forgetSeenRunErrorId(runId);
      setDismissedRunErrorIds((current) => {
        if (!current.has(runId)) return current;
        const next = new Set(current);
        next.delete(runId);
        return next;
      });
      updateSnapshot((prev) => {
        if (!prev || prev.run?.id !== runId) return prev;
        const nextRun = {
          ...prev.run,
          status: "queued" as const,
          error: null,
          resumable: undefined,
          completedAt: null,
        };
        const activeRuns = [
          ...(prev.activeRuns ?? []).filter((candidate) => candidate.id !== runId),
          nextRun,
        ];
        return { ...prev, run: nextRun, activeRuns };
      });
      if (groupTarget) {
        await refreshGroupThreadRef.current(groupTarget).catch(() => undefined);
      } else if (botTarget) {
        await refreshThreadRef.current(botTarget).catch(() => undefined);
      }
    },
    [t],
  );

  function dismissComposerError() {
    // The strip shows one message at a time, so only dismiss the run failure when it is the
    // one on screen; otherwise a live run would be silenced before it has even failed.
    const failedRunId = displayedRunErrorId;
    setSendError(null);
    if (failedRunId) {
      rememberSeenRunErrorId(failedRunId);
      setDismissedRunErrorIds((current) => new Set(current).add(failedRunId));
    }
  }

  const retryPendingSend = useCallback((clientNonce: string) => {
    retryWebSendAttempt(clientNonce);
  }, []);
  const sendPendingAsFile = useCallback((clientNonce: string) => {
    retryWebSendAttempt(clientNonce, { imageHandling: "file" });
  }, []);
  const discardPendingSend = useCallback((clientNonce: string) => {
    discardWebSendAttempt(clientNonce);
  }, []);

  return {
    activePendingAttachments,
    attachmentNotice,
    fileInputRef,
    onAttachmentPick,
    onDriveFilePick,
    removeAttachment,
    discardThreadAttachments,
    replyTarget: activeReplyTarget,
    replyQuote: activeReplyQuote,
    setReplyTarget,
    setReplyQuote,
    clearReply,
    // The composer's Send stays enabled while a message is queued; only Stop waits.
    sending: stopping,
    sentCount,
    sendMessage,
    pendingSends,
    retryPendingSend,
    sendPendingAsFile,
    discardPendingSend,
    stopRun,
    rewindRun,
    retryRun,
    retryingRun: retryingRunId !== null,
    answerMessage,
    reactToMessage,
    sendError,
    setSendError,
    imageConfirmation,
    clearImageConfirmation,
    dismissedRunErrorIds,
    displayedRunError,
    displayedRunErrorId,
    handleRunErrorPresented,
    dismissComposerError,
    startFocusPrompt,
  };
}
