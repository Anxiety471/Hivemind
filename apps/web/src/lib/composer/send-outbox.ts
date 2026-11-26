import { t } from "@lingui/core/macro";
import type { resolveComposerSendPlan } from "@rakazo/core";
import { classifySendFailure, isImageInputConfirmation, nextSendRetryDelayMs } from "@rakazo/core";
import type { PendingDriveFile } from "../../pages/shell/chat/chat-shared";
import {
  isBrowserOnline,
  isServerReachable,
  subscribeServerReachable,
} from "../query/connection-state";
import type { RpcClient } from "../query/rpc";
import { createSpaceRpc } from "../query/rpc";
import { errorText } from "../query/user-error";
import type { OutboxScope, StoredOutboxAttachment, StoredWebSendAttempt } from "./outbox-storage";
import { prepareImage } from "./prepare-image";

/** How many unsent messages this browser keeps, in memory and on disk. */
export const OUTBOX_MAX_ENTRIES = 20;

/**
 * IndexedDB is only needed once a send has to be saved or restored, so the storage module loads
 * on its own instead of holding the page's startup code.
 */
let outboxStorage: Promise<typeof import("./outbox-storage")> | undefined;
function loadOutboxStorage(): Promise<typeof import("./outbox-storage")> {
  outboxStorage ??= import("./outbox-storage");
  return outboxStorage;
}

async function putOutboxAttempt(record: StoredWebSendAttempt): Promise<boolean> {
  return (await loadOutboxStorage()).putOutboxAttempt(record);
}

function deleteOutboxAttempt(clientNonce: string): Promise<void> {
  return loadOutboxStorage().then((storage) => storage.deleteOutboxAttempt(clientNonce));
}

function clearOutboxStorage(): Promise<void> {
  return loadOutboxStorage().then((storage) => storage.clearOutboxStorage());
}

async function loadOutboxAttempts(scope: OutboxScope): Promise<StoredWebSendAttempt[]> {
  return (await loadOutboxStorage()).loadOutboxAttempts(scope);
}

/** The account and Space a queued send belongs to. */
export type WebOutboxScope = { userId: string; spaceId: string | null };

/** A picked file that still has to be uploaded, or a Drive file sent by reference. */
export type WebOutboxAttachment =
  | {
      kind: "file";
      id: string;
      name: string;
      mimeType: string;
      size: number;
      file: File;
      previewUrl?: string;
      uploadNonce: string;
    }
  | { kind: "drive"; id: string; driveFile: PendingDriveFile };

export type WebSendPayload = {
  originThreadKey: string;
  displayText: string;
  replyPreview: string | null;
  initialBotTarget?: string;
  botTarget?: string;
  groupTarget?: string;
  reroutedToGroup: boolean;
  plan: ReturnType<typeof resolveComposerSendPlan>;
  trimmed: string;
  replyToMessageId?: string;
  replyQuote?: string;
  fromPage?: true;
  attachments: WebOutboxAttachment[];
};

export type WebSendAttempt = {
  clientNonce: string;
  createdAt: number;
  scope: WebOutboxScope;
  payload: WebSendPayload;
  /** Uploaded files by pick id, so a retry never uploads the same bytes twice. */
  artifactIds: Map<string, string>;
  state: "queued" | "pending" | "failed" | "refused";
  acceptedSeq?: number;
  /** The run the accepted send started, shown as queued until the thread reports it. */
  acceptedRun?: { runId: string; taskId: string };
  error?: string;
  imageConfirmation?: boolean;
  imageHandling?: "file";
  retryCount: number;
  nextRetryAt?: number;
  persisted: boolean;
};

export type WebOutboxRpcResolver = (spaceId: string | null) => Pick<RpcClient, "threads">;

/** Replaced on every change so `useSyncExternalStore` sees a new snapshot. */
let attempts: WebSendAttempt[] = [];
/**
 * Bumped when the queue is cleared or handed to another account, so a delivery or restore that
 * started under the previous session cannot write into the current one.
 */
let sessionGeneration = 0;
let running: Promise<void> | undefined;
/** A drain asked for while one was in flight, run once that drain stops. */
let pendingForce: boolean | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const watchers = new Set<() => void>();
const deliveredListeners = new Set<(attempt: WebSendAttempt) => void>();
/** The seqs each chat has already shown, so an accepted send disappears once it lands. */
const echoes = new Map<string, Set<number>>();
/** Chats with a mounted screen; an accepted send stays visible only while one watches. */
const mountedThreads = new Map<string, number>();
let activeUserId: string | null = null;
let activeRpcResolver: WebOutboxRpcResolver | null = null;
let restoredForUser: string | null = null;
/** Started screens; the last one to stop releases the RPC resolver. */
const starters = new Set<object>();

function currentOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

/**
 * The upload client reaches into the shell's bootstrap, which only a browser page has, and most
 * sends carry no picked file: load it when the first file needs it.
 */
let uploadClient: Promise<typeof import("../files/file-client")> | undefined;
function loadUploadClient(): Promise<typeof import("../files/file-client")> {
  uploadClient ??= import("../files/file-client");
  return uploadClient;
}

function emit(): void {
  attempts = [...attempts];
  for (const watcher of [...watchers]) watcher();
}

function waitingAttempts(): WebSendAttempt[] {
  return attempts.filter((attempt) => attempt.acceptedSeq === undefined);
}

function clearRetryTimer(): void {
  if (retryTimer !== undefined) clearTimeout(retryTimer);
  retryTimer = undefined;
}

function scheduleRetry(delayMs: number): void {
  clearRetryTimer();
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void drainWebOutbox(true);
  }, delayMs);
}

function revokePreviews(attempt: WebSendAttempt): void {
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
  for (const attachment of attempt.payload.attachments) {
    if (attachment.kind === "file" && attachment.previewUrl)
      URL.revokeObjectURL(attachment.previewUrl);
  }
}

function toStoredAttachment(attachment: WebOutboxAttachment): StoredOutboxAttachment {
  if (attachment.kind === "drive")
    return { kind: "drive", id: attachment.id, driveFile: attachment.driveFile };
  return {
    kind: "file",
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    file: attachment.file,
    uploadNonce: attachment.uploadNonce,
  };
}

function toStoredAttempt(attempt: WebSendAttempt): StoredWebSendAttempt {
  return {
    clientNonce: attempt.clientNonce,
    createdAt: attempt.createdAt,
    scope: {
      origin: currentOrigin(),
      userId: attempt.scope.userId,
      spaceId: attempt.scope.spaceId,
    },
    // A send is only ever saved between deliveries, never while one is in flight.
    state: attempt.state === "pending" ? "queued" : attempt.state,
    payload: {
      ...attempt.payload,
      attachments: attempt.payload.attachments.map(toStoredAttachment),
    },
    artifactIds: [...attempt.artifactIds],
    retryCount: attempt.retryCount,
    ...(attempt.error === undefined ? {} : { error: attempt.error }),
    ...(attempt.imageConfirmation === undefined
      ? {}
      : { imageConfirmation: attempt.imageConfirmation }),
    ...(attempt.imageHandling === undefined ? {} : { imageHandling: attempt.imageHandling }),
  };
}

/** Saves the attempt, or drops the record when the send already settled while it was written. */
async function persistAttempt(attempt: WebSendAttempt): Promise<void> {
  const stored = await putOutboxAttempt(toStoredAttempt(attempt));
  if (!stored) return;
  if (attempts.includes(attempt) && attempt.acceptedSeq === undefined) attempt.persisted = true;
  else void deleteOutboxAttempt(attempt.clientNonce);
}

function removeAttempt(attempt: WebSendAttempt): void {
  if (!attempts.includes(attempt)) return;
  attempts = attempts.filter((other) => other !== attempt);
  revokePreviews(attempt);
  void deleteOutboxAttempt(attempt.clientNonce);
}

/**
 * Sends one attempt: uploads what it still needs, then hands the message to the server. The
 * uploads are kept on the attempt, so a retry after a failure resumes instead of starting over.
 */
export async function deliverWebSendAttempt(
  attempt: WebSendAttempt,
  rpc: Pick<RpcClient, "threads">,
): Promise<number | undefined> {
  const payload = attempt.payload;
  const plan = payload.plan;
  const target = payload.groupTarget
    ? { groupId: payload.groupTarget }
    : { botId: payload.botTarget! };
  if (!plan.shouldSend) {
    if (plan.shouldRunRoutines)
      await rpc.threads.sendWithRoutines({
        ...target,
        clientNonce: attempt.clientNonce,
        routineIds: plan.routineIds,
      });
    return undefined;
  }
  const artifactIds: string[] = [];
  for (const attachment of payload.attachments) {
    // A Drive file chosen in Files travels by reference; sending it uploads nothing again.
    if (attachment.kind === "drive") {
      artifactIds.push(attachment.driveFile.artifactId);
      continue;
    }
    let id = attempt.artifactIds.get(attachment.id);
    if (!id) {
      const { uploadSpaceFile } = await loadUploadClient();
      const prepared = await prepareImage(attachment.file);
      const uploaded = await uploadSpaceFile({
        file: prepared,
        ...target,
        source: "chat",
        // Scoped to the target, so a retry rerouted to a group uploads afresh instead of
        // replaying another chat's artifact.
        clientNonce: attachment.uploadNonce,
        spaceId: attempt.scope.spaceId,
      });
      id = uploaded.id;
      // Checkpoint at once: a later upload failure must not upload this file again.
      attempt.artifactIds.set(attachment.id, id);
      void persistAttempt(attempt);
    }
    artifactIds.push(id);
  }
  const message = {
    ...target,
    clientNonce: attempt.clientNonce,
    imageHandling: attempt.imageHandling ?? "confirm",
    text: payload.trimmed || undefined,
    mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
    artifactIds: artifactIds.length ? artifactIds : undefined,
    replyToMessageId: payload.reroutedToGroup ? undefined : payload.replyToMessageId,
    replyQuote: payload.reroutedToGroup ? undefined : payload.replyQuote,
    fromPage: payload.reroutedToGroup ? undefined : payload.fromPage,
  } as const;
  // The routines run in the same server operation as the message: both or neither.
  const sent = plan.shouldRunRoutines
    ? (await rpc.threads.sendWithRoutines({ ...message, routineIds: plan.routineIds })).send
    : undefined;
  // Runs already saved for this nonce return no message; the plain send saves or replays it.
  const accepted = sent ?? (await rpc.threads.send(message));
  if (accepted) {
    attempt.acceptedRun = { runId: accepted.runId, taskId: accepted.taskId };
    return accepted.seq;
  }
  return undefined;
}

/**
 * Sends what is queued, oldest first. A send that never reached the server keeps its place and
 * waits out a backoff, so a second message cannot overtake it; anything the server answered
 * badly is settled and later messages carry on.
 */
export function drainWebOutbox(force = false): Promise<void> {
  if (running) {
    pendingForce = pendingForce === true || force;
    return running;
  }
  // Whoever asked for a drain takes over from a scheduled retry instead of racing it.
  clearRetryTimer();
  const task = (async () => {
    let nextForce = force;
    for (;;) {
      let allowUnreachable = nextForce;
      for (;;) {
        if (!activeRpcResolver) break;
        const attempt = attempts.find(
          (candidate) =>
            candidate.state === "queued" &&
            candidate.acceptedSeq === undefined &&
            (!activeUserId || candidate.scope.userId === activeUserId),
        );
        if (!attempt) break;
        if (!allowUnreachable && !isServerReachable()) {
          // Without a network there is nothing to try: stay paused until the browser is online.
          if (isBrowserOnline()) {
            const delayMs = nextSendRetryDelayMs(undefined, attempt.retryCount);
            attempt.nextRetryAt = Date.now() + delayMs;
            emit();
            scheduleRetry(delayMs);
          }
          break;
        }
        allowUnreachable = false;
        attempt.state = "pending";
        attempt.error = undefined;
        attempt.nextRetryAt = undefined;
        emit();
        const generation = sessionGeneration;
        const resolver = activeRpcResolver;
        if (!resolver) break;
        try {
          const seq = await deliverWebSendAttempt(attempt, resolver(attempt.scope.spaceId));
          // Signed out or cleared while this was in flight: the result belongs to no queue.
          if (generation !== sessionGeneration || !attempts.includes(attempt)) continue;
          attempt.acceptedSeq = seq;
          attempt.retryCount = 0;
          attempt.error = undefined;
          void deleteOutboxAttempt(attempt.clientNonce);
          for (const listener of [...deliveredListeners]) listener(attempt);
          // Without a mounted chat there is nothing to echo into, and a rerouted message
          // belongs to another chat than the one that queued it.
          if (
            seq === undefined ||
            attempt.payload.reroutedToGroup ||
            !mountedThreads.has(attempt.payload.originThreadKey) ||
            echoes.get(attempt.payload.originThreadKey)?.has(seq)
          )
            removeAttempt(attempt);
          // Either way the attempt changed: a removed one must reach the watchers too.
          emit();
        } catch (error) {
          if (generation !== sessionGeneration || !attempts.includes(attempt)) continue;
          const disposition = classifySendFailure(error);
          attempt.error = errorText(error, t`Failed to send message`);
          if (disposition === "retry_connection") {
            const retries = attempt.retryCount + 1;
            attempt.retryCount = retries;
            attempt.state = "queued";
            attempt.imageConfirmation = false;
            const delayMs = nextSendRetryDelayMs(error, retries - 1);
            attempt.nextRetryAt = isBrowserOnline() ? Date.now() + delayMs : undefined;
            void persistAttempt(attempt);
            emit();
            if (isBrowserOnline()) scheduleRetry(delayMs);
            // The queue keeps its order: later messages wait behind this one.
            break;
          }
          attempt.state = disposition;
          attempt.imageConfirmation = disposition === "failed" && isImageInputConfirmation(error);
          attempt.nextRetryAt = undefined;
          void persistAttempt(attempt);
          emit();
        }
      }
      if (pendingForce === null) return;
      nextForce = pendingForce;
      pendingForce = null;
    }
  })().finally(() => {
    if (running !== task) return;
    running = undefined;
    if (pendingForce === null) return;
    const next = pendingForce;
    pendingForce = null;
    void drainWebOutbox(next);
  });
  running = task;
  return task;
}

export function enqueueWebSend(input: {
  clientNonce: string;
  scope: WebOutboxScope;
  payload: WebSendPayload;
  imageHandling?: "file";
}): WebSendAttempt {
  if (waitingAttempts().length >= OUTBOX_MAX_ENTRIES) throw new Error(t`Too many unsent messages`);
  const attempt: WebSendAttempt = {
    clientNonce: input.clientNonce,
    createdAt: Date.now(),
    scope: input.scope,
    payload: input.payload,
    artifactIds: new Map(),
    state: "queued",
    retryCount: 0,
    persisted: false,
    ...(input.imageHandling ? { imageHandling: input.imageHandling } : {}),
  };
  attempts = [...attempts, attempt];
  void persistAttempt(attempt);
  emit();
  void drainWebOutbox();
  return attempt;
}

function restoredAttachment(stored: StoredOutboxAttachment): WebOutboxAttachment {
  if (stored.kind === "drive") return { kind: "drive", id: stored.id, driveFile: stored.driveFile };
  // IndexedDB may hand back either, depending on the browser and the writing version.
  const file =
    typeof File === "function" && stored.file instanceof File
      ? stored.file
      : new File([stored.file], stored.name, { type: stored.mimeType });
  const attachment: WebOutboxAttachment = {
    kind: "file",
    id: stored.id,
    name: stored.name,
    mimeType: stored.mimeType,
    size: stored.size,
    file,
    uploadNonce: stored.uploadNonce,
  };
  // Previews are only for files this page created; a restored image needs its own again.
  if (
    stored.mimeType.startsWith("image/") &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function"
  )
    attachment.previewUrl = URL.createObjectURL(file);
  return attachment;
}

function restoredAttempt(stored: StoredWebSendAttempt): WebSendAttempt {
  return {
    clientNonce: stored.clientNonce,
    createdAt: stored.createdAt,
    scope: { userId: stored.scope.userId, spaceId: stored.scope.spaceId },
    payload: {
      ...stored.payload,
      attachments: stored.payload.attachments.map(restoredAttachment),
    },
    artifactIds: new Map(stored.artifactIds),
    // A send interrupted by the reload simply goes out again; a settled one keeps its verdict.
    state: stored.state === "failed" || stored.state === "refused" ? stored.state : "queued",
    retryCount: stored.retryCount,
    persisted: true,
    ...(stored.error === undefined ? {} : { error: stored.error }),
    ...(stored.imageConfirmation === undefined
      ? {}
      : { imageConfirmation: stored.imageConfirmation }),
    ...(stored.imageHandling === undefined ? {} : { imageHandling: stored.imageHandling }),
  };
}

async function restoreAttempts(userId: string, generation: number): Promise<void> {
  const loaded = await loadOutboxAttempts({ origin: currentOrigin(), userId });
  // The queue was cleared or handed to another account while storage was being read.
  if (generation !== sessionGeneration) return;
  const known = new Set(attempts.map((attempt) => attempt.clientNonce));
  const restored = loaded
    .filter((stored) => !known.has(stored.clientNonce))
    .map(restoredAttempt)
    .sort((left, right) => left.createdAt - right.createdAt);
  if (!restored.length) return;
  attempts = [...attempts, ...restored].sort((left, right) => left.createdAt - right.createdAt);
  emit();
  void drainWebOutbox();
}

/**
 * Starts the outbox for the signed-in account: restores what the last page left, sends it, and
 * sends again whenever the connection comes back or the window is looked at.
 */
export function startWebOutbox(options: {
  userId: string;
  rpcForSpace?: WebOutboxRpcResolver;
}): () => void {
  activeRpcResolver = options.rpcForSpace ?? ((spaceId) => createSpaceRpc(spaceId));
  if (activeUserId && activeUserId !== options.userId) {
    const previous = attempts;
    attempts = [];
    for (const attempt of previous) revokePreviews(attempt);
    sessionGeneration += 1;
    clearRetryTimer();
    restoredForUser = null;
  }
  activeUserId = options.userId;
  if (restoredForUser !== options.userId) {
    restoredForUser = options.userId;
    void restoreAttempts(options.userId, sessionGeneration);
  }
  const token = {};
  starters.add(token);
  const unsubscribers: Array<() => void> = [
    subscribeServerReachable((reachable) => {
      if (reachable) void drainWebOutbox(true);
    }),
  ];
  if (typeof window !== "undefined") {
    const online = () => void drainWebOutbox(true);
    const focus = () => void drainWebOutbox(true);
    window.addEventListener("online", online);
    window.addEventListener("focus", focus);
    unsubscribers.push(() => {
      window.removeEventListener("online", online);
      window.removeEventListener("focus", focus);
    });
  }
  if (typeof document !== "undefined") {
    const visibility = () => {
      if (document.visibilityState === "visible") void drainWebOutbox(true);
    };
    document.addEventListener("visibilitychange", visibility);
    unsubscribers.push(() => document.removeEventListener("visibilitychange", visibility));
  }
  void drainWebOutbox();
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    starters.delete(token);
    if (!starters.size) activeRpcResolver = null;
  };
}

export function retryWebSendAttempt(
  clientNonce: string,
  options?: { imageHandling?: "file" },
): void {
  const attempt = attempts.find((candidate) => candidate.clientNonce === clientNonce);
  if (!attempt || attempt.state === "pending" || attempt.state === "refused") return;
  attempt.retryCount = 0;
  attempt.error = undefined;
  attempt.imageConfirmation = false;
  attempt.nextRetryAt = undefined;
  if (options?.imageHandling) attempt.imageHandling = options.imageHandling;
  attempt.state = "queued";
  void persistAttempt(attempt);
  emit();
  void drainWebOutbox(true);
}

export function discardWebSendAttempt(clientNonce: string): void {
  const attempt = attempts.find((candidate) => candidate.clientNonce === clientNonce);
  if (!attempt || attempt.state === "pending") return;
  removeAttempt(attempt);
  // Nothing waits behind it: a scheduled retry would only find an empty queue.
  if (!attempts.some((candidate) => candidate.state === "queued")) clearRetryTimer();
  emit();
}

export function discardWebThreadOutbox(threadKey: string): void {
  for (const attempt of [...attempts]) {
    if (attempt.state === "pending") continue;
    if (attempt.payload.originThreadKey === threadKey) discardWebSendAttempt(attempt.clientNonce);
  }
}

/** Signs out or resets: no queued message, preview or timer outlives this call. */
export function clearWebOutbox(): void {
  sessionGeneration += 1;
  clearRetryTimer();
  const cleared = attempts;
  attempts = [];
  for (const attempt of cleared) revokePreviews(attempt);
  echoes.clear();
  pendingForce = null;
  restoredForUser = null;
  activeUserId = null;
  void clearOutboxStorage();
  emit();
}

/** An accepted send disappears once the chat shows the message it became. */
export function confirmWebEchoes(threadKey: string, seqs: Iterable<number>): void {
  const seen = new Set(seqs);
  echoes.set(threadKey, seen);
  let removed = false;
  for (const attempt of [...attempts]) {
    if (
      attempt.payload.originThreadKey === threadKey &&
      attempt.acceptedSeq !== undefined &&
      seen.has(attempt.acceptedSeq)
    ) {
      removeAttempt(attempt);
      removed = true;
    }
  }
  if (removed) emit();
}

/** A mounted chat keeps its accepted send visible until the message echoes back to it. */
export function registerWebThreadScreen(threadKey: string): () => void {
  mountedThreads.set(threadKey, (mountedThreads.get(threadKey) ?? 0) + 1);
  return () => {
    const remaining = (mountedThreads.get(threadKey) ?? 1) - 1;
    if (remaining > 0) {
      mountedThreads.set(threadKey, remaining);
      return;
    }
    mountedThreads.delete(threadKey);
    echoes.delete(threadKey);
    // Nobody is watching the chat any more, so its accepted sends have nothing to wait for.
    let removed = false;
    for (const attempt of [...attempts])
      if (attempt.payload.originThreadKey === threadKey && attempt.acceptedSeq !== undefined) {
        removeAttempt(attempt);
        removed = true;
      }
    if (removed) emit();
  };
}

export function subscribeWebOutbox(listener: () => void): () => void {
  watchers.add(listener);
  return () => {
    watchers.delete(listener);
  };
}

export function getWebOutboxAttempts(): readonly WebSendAttempt[] {
  return attempts;
}

export function subscribeWebOutboxDelivered(
  listener: (attempt: WebSendAttempt) => void,
): () => void {
  deliveredListeners.add(listener);
  return () => {
    deliveredListeners.delete(listener);
  };
}

/** True while a message is queued or failed; a reload or sign-out would lose it. */
export function hasUnsentWebSends(threadKey?: string): boolean {
  return attempts.some(
    (attempt) =>
      attempt.acceptedSeq === undefined &&
      (threadKey === undefined || attempt.payload.originThreadKey === threadKey),
  );
}

/** True while a send is waiting for the server's answer right now. */
export function hasInFlightWebSends(): boolean {
  return attempts.some((attempt) => attempt.state === "pending");
}

/** Test-only: drop everything the queue holds, as a fresh page would start. */
export function resetWebOutboxForTests(): void {
  sessionGeneration += 1;
  clearRetryTimer();
  for (const attempt of attempts) revokePreviews(attempt);
  attempts = [];
  echoes.clear();
  mountedThreads.clear();
  deliveredListeners.clear();
  starters.clear();
  activeRpcResolver = null;
  activeUserId = null;
  restoredForUser = null;
  pendingForce = null;
  running = undefined;
  emit();
}
