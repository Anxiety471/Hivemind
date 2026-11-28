// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import type { ComposerMention } from "@rakazo/core";
import { resolveComposerSendPlan } from "@rakazo/core";
import { deferred, flush } from "@rakazo/core/test-async";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noteServerReachable, resetServerReachableForTests } from "../query/connection-state";
import type { RpcClient } from "../query/rpc";
import { composerHoldsUnsavedWork, composerHoldsWorkInFlight } from "./composer-draft";
import type { StoredOutboxAttachment, StoredWebSendAttempt } from "./outbox-storage";
import {
  clearOutboxStorage,
  deleteOutboxAttempt,
  loadOutboxAttempts,
  OUTBOX_MAX_BYTES,
  putOutboxAttempt,
  resetOutboxStorageForTests,
} from "./outbox-storage";
import type { WebOutboxAttachment, WebSendAttempt, WebSendPayload } from "./send-outbox";
import {
  claimWebEchoMessage,
  clearWebOutbox,
  confirmWebEchoes,
  discardWebSendAttempt,
  enqueueWebSend,
  getWebOutboxAttempts,
  hasInFlightWebSends,
  hasUnsentWebSends,
  matchesInFlightEcho,
  OUTBOX_MAX_ENTRIES,
  registerWebThreadScreen,
  resetWebOutboxForTests,
  retryWebSendAttempt,
  startWebOutbox,
  webEchoMessageOwner,
} from "./send-outbox";

const mocks = vi.hoisted(() => ({
  prepareImage: vi.fn(async (file: File) => file),
  uploadSpaceFile: vi.fn(),
  createSpaceRpc: vi.fn(() => {
    throw new Error("the test supplies its own RPC");
  }),
}));

vi.mock("./prepare-image", () => ({
  canPrepareImage: () => false,
  prepareImage: mocks.prepareImage,
}));
vi.mock("../files/file-client", () => ({ uploadSpaceFile: mocks.uploadSpaceFile }));
vi.mock("../query/rpc", () => ({
  createSpaceRpc: mocks.createSpaceRpc,
  selectedSpaceId: () => null,
}));

type SendMessage = {
  botId?: string;
  groupId?: string;
  clientNonce?: string;
  imageHandling?: "confirm" | "file";
  text?: string;
  artifactIds?: string[];
  mentions?: ComposerMention[];
  replyToMessageId?: string;
  replyQuote?: string;
  fromPage?: true;
};
type SendResult = { taskId: string; runId: string; seq: number };

function threads(
  overrides: {
    send?: (input: SendMessage) => Promise<SendResult>;
    sendWithRoutines?: (input: SendMessage & { routineIds: string[] }) => Promise<{
      routineRunIds: string[];
      send?: SendResult;
    }>;
  } = {},
) {
  const send = vi.fn(
    overrides.send ?? (async (): Promise<SendResult> => ({ taskId: "task", runId: "run", seq: 1 })),
  );
  const sendWithRoutines = vi.fn(
    overrides.sendWithRoutines ??
      (async () => ({
        routineRunIds: [],
        send: { taskId: "task-routines", runId: "run-routines", seq: 2 },
      })),
  );
  const client = { threads: { send, sendWithRoutines } } as unknown as Pick<RpcClient, "threads">;
  return { send, sendWithRoutines, client };
}

function planFor(text: string, hasAttachments = false) {
  return resolveComposerSendPlan({ text, mentions: [], hasAttachments });
}

const scope = { userId: "user-1", spaceId: "space-1" };

function payload(overrides: Partial<WebSendPayload> = {}): WebSendPayload {
  const text = overrides.trimmed ?? "hello";
  return {
    originThreadKey: "bot:1",
    displayText: text,
    replyPreview: null,
    botTarget: "bot-1",
    reroutedToGroup: false,
    plan: planFor(text),
    trimmed: text,
    attachments: [],
    ...overrides,
  };
}

function fileAttachment(
  id: string,
  options: { name?: string; mimeType?: string; previewUrl?: string } = {},
): WebOutboxAttachment {
  const name = options.name ?? `${id}.png`;
  const file = new File(["bytes"], name, { type: options.mimeType ?? "image/png" });
  return {
    kind: "file",
    id,
    name,
    mimeType: options.mimeType ?? "image/png",
    size: file.size,
    file,
    uploadNonce: `attachment:bot-1:${id}`,
    ...(options.previewUrl ? { previewUrl: options.previewUrl } : {}),
  };
}

let stop: (() => void) | undefined;
let revokeObjectURL: ReturnType<typeof vi.fn> | undefined;

function start(client: Pick<RpcClient, "threads">) {
  stop = startWebOutbox({ userId: scope.userId, rpcForSpace: () => client });
}

function captureRevokedPreviews() {
  revokeObjectURL = vi.fn();
  const previous = URL.revokeObjectURL;
  URL.revokeObjectURL = revokeObjectURL as typeof URL.revokeObjectURL;
  return () => {
    URL.revokeObjectURL = previous;
  };
}

beforeEach(() => {
  resetWebOutboxForTests();
  resetOutboxStorageForTests();
  resetServerReachableForTests(true);
  mocks.prepareImage.mockReset();
  mocks.prepareImage.mockImplementation(async (file: File) => file);
  mocks.uploadSpaceFile.mockReset();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
  window.localStorage.clear();
});

afterEach(() => {
  stop?.();
  stop = undefined;
  resetWebOutboxForTests();
  resetOutboxStorageForTests();
  resetServerReachableForTests(true);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("web send outbox", () => {
  it("sends queued messages one at a time, in the order they were written", async () => {
    const gate = deferred();
    const sent: string[] = [];
    let calls = 0;
    const { send, client } = threads({
      send: async (input) => {
        sent.push(input.text ?? "");
        const current = ++calls;
        if (current === 1) await gate.promise;
        return { taskId: `task-${current}`, runId: `run-${current}`, seq: current };
      },
    });
    const unmount = registerWebThreadScreen("bot:1");
    start(client);

    enqueueWebSend({
      clientNonce: "first",
      scope,
      payload: payload({ trimmed: "one", plan: planFor("one") }),
    });
    enqueueWebSend({
      clientNonce: "second",
      scope,
      payload: payload({ trimmed: "two", plan: planFor("two") }),
    });

    await vi.waitFor(() => expect(sent).toEqual(["one"]));
    expect(send).toHaveBeenCalledTimes(1);

    gate.resolve();
    await vi.waitFor(() => expect(sent).toEqual(["one", "two"]));
    // The chat is on screen, so both accepted sends stay until the thread echoes them.
    await vi.waitFor(() =>
      expect(getWebOutboxAttempts().map((attempt) => attempt.acceptedSeq)).toEqual([1, 2]),
    );
    expect(hasUnsentWebSends()).toBe(false);
    unmount();
    expect(getWebOutboxAttempts()).toHaveLength(0);
  });

  it("uploads picked files with their own nonce and sends Drive files by reference", async () => {
    const picked = fileAttachment("pick-1");
    const prepared = new File(["prepared"], "pick-1.png", { type: "image/png" });
    mocks.prepareImage.mockResolvedValue(prepared);
    mocks.uploadSpaceFile.mockResolvedValue({
      id: "artifact-uploaded",
      name: "pick-1.png",
      mimeType: "image/png",
      size: prepared.size,
    });
    const { send, client } = threads();
    start(client);
    // The selected Space may change while the message waits; the attempt keeps its own.
    window.localStorage.setItem("rakazo:space-id", "space-other");

    enqueueWebSend({
      clientNonce: "with-files",
      scope,
      payload: payload({
        trimmed: "",
        displayText: "two files",
        plan: planFor("", true),
        attachments: [
          picked,
          {
            kind: "drive",
            id: "pick-2",
            driveFile: {
              artifactId: "artifact-drive",
              name: "notes.pdf",
              mimeType: "application/pdf",
              size: 10,
            },
          },
        ],
      }),
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(mocks.prepareImage).toHaveBeenCalledWith((picked as { kind: "file"; file: File }).file);
    expect(mocks.uploadSpaceFile).toHaveBeenCalledTimes(1);
    expect(mocks.uploadSpaceFile).toHaveBeenCalledWith({
      file: prepared,
      botId: "bot-1",
      source: "chat",
      clientNonce: "attachment:bot-1:pick-1",
      spaceId: "space-1",
    });
    expect(send.mock.calls[0]![0]).toMatchObject({
      botId: "bot-1",
      clientNonce: "with-files",
      artifactIds: ["artifact-uploaded", "artifact-drive"],
    });
  });

  it("resumes a multi-file send after a failure without re-uploading finished files", async () => {
    vi.useFakeTimers();
    let uploads = 0;
    mocks.uploadSpaceFile.mockImplementation(async (input: { clientNonce?: string }) => {
      uploads += 1;
      const id = input.clientNonce === "attachment:bot-1:pick-a" ? "artifact-a" : "artifact-b";
      // The second file's first upload never reaches the server.
      if (uploads === 2) throw Object.assign(new Error("Bad gateway"), { status: 503 });
      return { id, name: "file.png", mimeType: "image/png", size: 1 };
    });
    const { send, client } = threads();
    start(client);
    const attempt = enqueueWebSend({
      clientNonce: "resume",
      scope,
      payload: payload({
        trimmed: "",
        plan: planFor("", true),
        attachments: [fileAttachment("pick-a"), fileAttachment("pick-b")],
      }),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.uploadSpaceFile).toHaveBeenCalledTimes(2);
    expect(attempt.state).toBe("queued");
    expect(attempt.retryCount).toBe(1);
    expect(attempt.artifactIds.get("pick-a")).toBe("artifact-a");
    expect(send).not.toHaveBeenCalled();

    // The backoff retry resumes with the file it has no artifact for, then sends both.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.uploadSpaceFile.mock.calls.map((call) => call[0].clientNonce)).toEqual([
      "attachment:bot-1:pick-a",
      "attachment:bot-1:pick-b",
      "attachment:bot-1:pick-b",
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].artifactIds).toEqual(["artifact-a", "artifact-b"]);
    expect(getWebOutboxAttempts()).toHaveLength(0);
  });

  it("holds messages while offline and sends them when the network returns", async () => {
    const { send, client } = threads();
    start(client);
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false });
    noteServerReachable(false);
    enqueueWebSend({ clientNonce: "offline", scope, payload: payload({ trimmed: "offline" }) });
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(hasUnsentWebSends()).toBe(true);
    // With no network there is nothing to try, so no retry is scheduled either.
    expect(getWebOutboxAttempts()[0]?.nextRetryAt).toBeUndefined();

    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0]).toMatchObject({ text: "offline", clientNonce: "offline" });
  });

  it("waits out a server that stopped answering and sends when it answers again", async () => {
    const { send, client } = threads();
    start(client);
    noteServerReachable(false);
    enqueueWebSend({
      clientNonce: "unreachable",
      scope,
      payload: payload({ trimmed: "later" }),
    });
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(getWebOutboxAttempts()[0]?.nextRetryAt).toBeGreaterThan(Date.now());

    noteServerReachable(true);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![0].text).toBe("later");
    await vi.waitFor(() => expect(hasUnsentWebSends()).toBe(false));
  });

  it("keeps transient failures queued, in order, and retries them with backoff", async () => {
    vi.useFakeTimers();
    const failures: Array<{ status: number; retryAfterMs?: number }> = [
      { status: 429, retryAfterMs: 4_000 },
      { status: 502 },
      { status: 503 },
      { status: 504 },
    ];
    let calls = 0;
    const { send, client } = threads({
      send: async (input) => {
        calls += 1;
        const failure = input.text === "one" ? failures[calls - 1] : undefined;
        if (failure) throw Object.assign(new Error(`Failed (${failure.status})`), failure);
        return { taskId: `task-${calls}`, runId: `run-${calls}`, seq: calls };
      },
    });
    start(client);
    const first = enqueueWebSend({
      clientNonce: "transient",
      scope,
      payload: payload({ trimmed: "one", plan: planFor("one") }),
    });
    enqueueWebSend({
      clientNonce: "second",
      scope,
      payload: payload({ trimmed: "two", plan: planFor("two") }),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(first.state).toBe("queued");
    expect(first.retryCount).toBe(1);
    expect(first.error).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].text).toBe("one");

    // The rate limit asked for four seconds; the faster base backoff must not win.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(send.mock.calls.map((call) => call[0].text)).toEqual(["one", "one"]);
    expect(first.retryCount).toBe(2);

    // Each gateway answer doubles the wait, and the second message never overtakes.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(first.retryCount).toBe(3);
    expect(send.mock.calls.map((call) => call[0].text)).toEqual(["one", "one", "one"]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(first.retryCount).toBe(4);
    expect(send.mock.calls.map((call) => call[0].text)).toEqual(["one", "one", "one", "one"]);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(send.mock.calls.map((call) => call[0].text)).toEqual([
      "one",
      "one",
      "one",
      "one",
      "one",
      "two",
    ]);
    expect(hasUnsentWebSends()).toBe(false);
  });

  it("marks a refused message and keeps draining the messages behind it", async () => {
    const refusals = new Map<string, number>([
      ["bad-400", 400],
      ["bad-403", 403],
      ["bad-413", 413],
    ]);
    const { send, client } = threads({
      send: async (input) => {
        const status = refusals.get(input.text ?? "");
        if (status) throw Object.assign(new Error(`Request rejected (${status})`), { status });
        return { taskId: "task-ok", runId: "run-ok", seq: 9 };
      },
    });
    start(client);
    for (const text of ["bad-400", "bad-403", "bad-413", "good"])
      enqueueWebSend({
        clientNonce: text,
        scope,
        payload: payload({ trimmed: text, plan: planFor(text) }),
      });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));
    const queued = getWebOutboxAttempts();
    expect(queued.map((attempt) => attempt.clientNonce)).toEqual(["bad-400", "bad-403", "bad-413"]);
    for (const attempt of queued) {
      expect(attempt.state).toBe("refused");
      expect(attempt.error).toBe("Failed to send message");
    }
    // Refused messages stay until the person discards them, so a reload still reports them.
    expect(hasUnsentWebSends()).toBe(true);
  });

  it("fails what asking again cannot settle and retries it by hand", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { send, client } = threads({
      send: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("Internal error"), { status: 500 });
        if (calls === 2)
          throw Object.assign(new Error("The model cannot read this image"), {
            status: 409,
            data: { reason: "model_image_input_unsupported" },
          });
        return result(calls);
      },
    });
    start(client);
    const attempt = enqueueWebSend({
      clientNonce: "manual",
      scope,
      payload: payload({ trimmed: "retry me" }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt.state).toBe("failed");
    expect(attempt.imageConfirmation).toBe(false);

    retryWebSendAttempt("manual", { imageHandling: "file" });
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt.state).toBe("failed");
    // The server rejected the image input, so the person can resend it as a plain file.
    expect(attempt.imageConfirmation).toBe(true);

    retryWebSendAttempt("manual", { imageHandling: "file" });
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls[2]![0]).toMatchObject({
      imageHandling: "file",
      clientNonce: "manual",
    });
    expect(getWebOutboxAttempts()).toHaveLength(0);
  });

  it("discards a failed message and releases its preview", async () => {
    const restoreUrl = captureRevokedPreviews();
    try {
      const { client } = threads({
        send: async () => {
          throw Object.assign(new Error("Internal error"), { status: 500 });
        },
      });
      start(client);
      enqueueWebSend({
        clientNonce: "discard",
        scope,
        payload: payload({
          trimmed: "",
          plan: planFor("", true),
          attachments: [fileAttachment("pick-d", { previewUrl: "blob:discard" })],
        }),
      });
      await vi.waitFor(() => expect(getWebOutboxAttempts()[0]?.state).toBe("failed"));

      discardWebSendAttempt("discard");
      expect(getWebOutboxAttempts()).toHaveLength(0);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:discard");
      expect(hasUnsentWebSends()).toBe(false);
    } finally {
      restoreUrl();
    }
  });

  it("keeps an accepted send visible until the chat echoes it", async () => {
    const restoreUrl = captureRevokedPreviews();
    try {
      mocks.uploadSpaceFile.mockResolvedValue({
        id: "artifact-echo",
        name: "pick-e.png",
        mimeType: "image/png",
        size: 5,
      });
      const unmount = registerWebThreadScreen("bot:1");
      const { client } = threads();
      start(client);
      enqueueWebSend({
        clientNonce: "echo",
        scope,
        payload: payload({
          trimmed: "",
          plan: planFor("", true),
          attachments: [fileAttachment("pick-e", { previewUrl: "blob:echo" })],
        }),
      });

      await vi.waitFor(() => expect(getWebOutboxAttempts()[0]?.acceptedSeq).toBe(1));
      // Another chat's echo says nothing about this one.
      confirmWebEchoes("bot:2", [1]);
      expect(getWebOutboxAttempts()).toHaveLength(1);

      confirmWebEchoes("bot:1", [1]);
      expect(getWebOutboxAttempts()).toHaveLength(0);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:echo");
      unmount();
    } finally {
      restoreUrl();
    }
  });

  it("clears timers, state and previews, and reports unsaved work honestly", async () => {
    vi.useFakeTimers();
    const restoreUrl = captureRevokedPreviews();
    try {
      const { send, client } = threads();
      start(client);
      noteServerReachable(false);
      enqueueWebSend({
        clientNonce: "clear",
        scope,
        payload: payload({
          trimmed: "",
          plan: planFor("", true),
          attachments: [fileAttachment("pick-c", { previewUrl: "blob:clear" })],
        }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(getWebOutboxAttempts()).toHaveLength(1);
      expect(getWebOutboxAttempts()[0]?.nextRetryAt).toBeDefined();
      expect(composerHoldsUnsavedWork()).toBe(true);
      expect(composerHoldsWorkInFlight()).toBe(false);

      clearWebOutbox();
      expect(getWebOutboxAttempts()).toHaveLength(0);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:clear");
      expect(composerHoldsUnsavedWork()).toBe(false);
      // The backoff that was waiting for the connection must not bring anything back.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(send).not.toHaveBeenCalled();
      expect(getWebOutboxAttempts()).toHaveLength(0);
    } finally {
      restoreUrl();
    }
  });

  it("reports an in-flight send as work a reload would lose", async () => {
    const gate = deferred();
    const { client } = threads({
      send: async () => {
        await gate.promise;
        return { taskId: "task", runId: "run", seq: 1 };
      },
    });
    start(client);
    expect(composerHoldsWorkInFlight()).toBe(false);
    enqueueWebSend({ clientNonce: "inflight", scope, payload: payload({ trimmed: "hold" }) });
    await vi.waitFor(() => expect(hasInFlightWebSends()).toBe(true));
    expect(composerHoldsWorkInFlight()).toBe(true);
    gate.resolve();
    await vi.waitFor(() => expect(composerHoldsWorkInFlight()).toBe(false));
    expect(getWebOutboxAttempts()).toHaveLength(0);
  });

  it("queues without IndexedDB and caps the queue at its entry limit", async () => {
    expect(typeof indexedDB).toBe("undefined");
    expect(
      await loadOutboxAttempts({ origin: window.location.origin, userId: scope.userId }),
    ).toEqual([]);
    expect(await putOutboxAttempt(storedAttempt("memory", 1))).toBe(false);

    const { send, client } = threads({
      send: async (input) => ({ taskId: `t-${input.clientNonce}`, runId: "run", seq: 1 }),
    });
    start(client);
    for (let index = 0; index < OUTBOX_MAX_ENTRIES; index++)
      enqueueWebSend({
        clientNonce: `cap-${index}`,
        scope,
        payload: payload({ trimmed: `cap ${index}` }),
      });
    expect(() =>
      enqueueWebSend({ clientNonce: "overflow", scope, payload: payload({ trimmed: "extra" }) }),
    ).toThrow("Too many unsent messages");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(OUTBOX_MAX_ENTRIES));
    expect(getWebOutboxAttempts()).toHaveLength(0);
  });

  it("restores the queue the previous page saved and sends it once the server answers", async () => {
    installFakeIndexedDb();
    const first = threads();
    start(first.client);
    noteServerReachable(false);
    enqueueWebSend({
      clientNonce: "restored",
      scope,
      payload: payload({ trimmed: "after reload" }),
    });
    await flush();
    expect(first.send).not.toHaveBeenCalled();

    // A new page: memory is gone, storage is not.
    stop?.();
    stop = undefined;
    resetWebOutboxForTests();
    noteServerReachable(false);
    const second = threads();
    start(second.client);
    await vi.waitFor(() => expect(getWebOutboxAttempts()).toHaveLength(1));
    expect(getWebOutboxAttempts()[0]?.clientNonce).toBe("restored");
    expect(getWebOutboxAttempts()[0]?.persisted).toBe(true);
    expect(second.send).not.toHaveBeenCalled();

    noteServerReachable(true);
    await vi.waitFor(() => expect(second.send).toHaveBeenCalledTimes(1));
    expect(second.send.mock.calls[0]![0]).toMatchObject({ text: "after reload" });
    // The delivered message is gone from storage too, so it cannot come back on the next page.
    await flush();
    expect(
      await loadOutboxAttempts({ origin: window.location.origin, userId: scope.userId }),
    ).toEqual([]);
  });
});

describe("outbox storage", () => {
  it("keeps one account's attempts and returns them oldest first", async () => {
    installFakeIndexedDb();
    await putOutboxAttempt(storedAttempt("second", 2));
    await putOutboxAttempt(storedAttempt("first", 1));
    await putOutboxAttempt(storedAttempt("other-user", 3, { userId: "user-2" }));
    await putOutboxAttempt(storedAttempt("other-origin", 4, { origin: "https://elsewhere.test" }));

    const stored = await loadOutboxAttempts({ origin: "https://app.test", userId: "user-1" });
    expect(stored.map((attempt) => attempt.clientNonce)).toEqual(["first", "second"]);

    await deleteOutboxAttempt("first");
    expect(
      (await loadOutboxAttempts({ origin: "https://app.test", userId: "user-1" })).map(
        (attempt) => attempt.clientNonce,
      ),
    ).toEqual(["second"]);

    await clearOutboxStorage();
    expect(await loadOutboxAttempts({ origin: "https://app.test", userId: "user-1" })).toEqual([]);
  });

  it("refuses an attempt that would push the stored files over the byte budget", async () => {
    installFakeIndexedDb();
    const half = OUTBOX_MAX_BYTES / 2 + 1;
    expect(await putOutboxAttempt(storedAttempt("big", 1, { fileBytes: half }))).toBe(true);
    expect(await putOutboxAttempt(storedAttempt("bigger", 2, { fileBytes: half }))).toBe(false);
    // Replacing the same attempt counts its bytes once.
    expect(await putOutboxAttempt(storedAttempt("big", 1, { fileBytes: half }))).toBe(true);
    expect(await putOutboxAttempt(storedAttempt("small", 3))).toBe(true);
  });

  it("treats a browser without storage as memory-only", async () => {
    expect(await loadOutboxAttempts({ origin: "https://app.test", userId: "user-1" })).toEqual([]);
    expect(await putOutboxAttempt(storedAttempt("nowhere", 1))).toBe(false);
    await expect(deleteOutboxAttempt("nowhere")).resolves.toBeUndefined();
    await expect(clearOutboxStorage()).resolves.toBeUndefined();
  });
});

function result(seq: number): SendResult {
  return { taskId: `task-${seq}`, runId: `run-${seq}`, seq };
}

function storedAttempt(
  nonce: string,
  createdAt: number,
  options: { userId?: string; origin?: string; fileBytes?: number } = {},
): StoredWebSendAttempt {
  const attachments: StoredOutboxAttachment[] = [];
  if (options.fileBytes) {
    const file = new File(["x"], `${nonce}.bin`);
    Object.defineProperty(file, "size", { value: options.fileBytes });
    attachments.push({
      kind: "file",
      id: `${nonce}-file`,
      name: file.name,
      mimeType: "application/octet-stream",
      size: file.size,
      file,
      uploadNonce: `attachment:bot-1:${nonce}`,
    });
  }
  return {
    clientNonce: nonce,
    createdAt,
    scope: {
      origin: options.origin ?? "https://app.test",
      userId: options.userId ?? "user-1",
      spaceId: null,
    },
    state: "queued",
    payload: {
      originThreadKey: "bot:1",
      displayText: nonce,
      replyPreview: null,
      botTarget: "bot-1",
      reroutedToGroup: false,
      plan: planFor(nonce, attachments.length > 0),
      trimmed: nonce,
      attachments,
    },
    artifactIds: [],
    retryCount: 0,
  };
}

/**
 * The smallest IndexedDB the outbox uses: one store, keyed by clientNonce, with transactions that
 * complete on a microtask. jsdom has none, so persistence needs one to be exercised.
 */
function installFakeIndexedDb() {
  type Store = Map<string, StoredWebSendAttempt>;
  const stores = new Map<string, Store>();

  function request<T>(result: T) {
    const source = {
      result,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };
    queueMicrotask(() => source.onsuccess?.());
    return source;
  }

  const database = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => {
      stores.set(name, new Map());
      return {};
    },
    transaction: (name: string) => {
      const store: Store = stores.get(name) ?? new Map<string, StoredWebSendAttempt>();
      stores.set(name, store);
      const transaction = {
        error: null as unknown,
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
        objectStore: () => ({
          getAll: () => request([...store.values()]),
          put: (record: StoredWebSendAttempt) => {
            store.set(record.clientNonce, record);
            return request(undefined);
          },
          delete: (key: string) => {
            store.delete(String(key));
            return request(undefined);
          },
          clear: () => {
            store.clear();
            return request(undefined);
          },
        }),
      };
      queueMicrotask(() => transaction.oncomplete?.());
      return transaction;
    },
    close: () => undefined,
  };

  vi.stubGlobal("indexedDB", {
    open: () => {
      const request = {
        result: database,
        error: null as unknown,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onblocked: null as (() => void) | null,
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  });
  resetOutboxStorageForTests();
}

describe("matchesInFlightEcho", () => {
  function attempt(
    overrides: Partial<WebSendAttempt> = {},
    payloadOverrides: Partial<WebSendPayload> = {},
  ): WebSendAttempt {
    return {
      clientNonce: "nonce-1",
      createdAt: 1,
      scope,
      payload: payload(payloadOverrides),
      artifactIds: new Map(),
      state: "pending",
      retryCount: 0,
      persisted: false,
      baselineMessageIds: new Set(["before-1"]),
      ...overrides,
    };
  }
  function message(
    overrides: Partial<ThreadMessage> = {},
  ): Pick<ThreadMessage, "id" | "role" | "blocks" | "author"> {
    return { id: "echo-1", role: "user", blocks: [{ kind: "text", text: "hello" }], ...overrides };
  }

  it("matches the in-flight send's own words, however their blocks are split", () => {
    expect(matchesInFlightEcho(attempt(), message(), "user-1")).toBe(true);
    expect(
      matchesInFlightEcho(
        attempt(),
        message({
          blocks: [
            { kind: "text", text: "hel" },
            { kind: "text", text: "lo" },
          ],
        }),
        "user-1",
      ),
    ).toBe(false);
    expect(
      matchesInFlightEcho(
        attempt({}, { trimmed: "hello there" }),
        message({ blocks: [{ kind: "text", text: "hello there" }] }),
        "user-1",
      ),
    ).toBe(true);
  });

  it("matches the words the bubble shows, when a page marker leads the sent text", () => {
    const shown = attempt({}, { trimmed: "and notes", displayText: "[Sales](page:p1)\nand notes" });
    expect(
      matchesInFlightEcho(
        shown,
        message({ blocks: [{ kind: "text", text: "and notes" }] }),
        "user-1",
      ),
    ).toBe(true);
  });

  it("never matches a message that was already in the thread, or another writer's", () => {
    expect(matchesInFlightEcho(attempt(), message({ id: "before-1" }), "user-1")).toBe(false);
    // A send restored from storage has no baseline, so its chat's older look-alikes must not match.
    expect(
      matchesInFlightEcho(attempt({ baselineMessageIds: undefined }), message(), "user-1"),
    ).toBe(false);
    expect(
      matchesInFlightEcho(
        attempt(),
        message({ author: { id: "user-2", name: "Other" } }),
        "user-1",
      ),
    ).toBe(false);
    expect(
      matchesInFlightEcho(attempt(), message({ author: { id: "user-1", name: "Me" } }), "user-1"),
    ).toBe(true);
  });

  it("matches only an image and attachment count that agree", () => {
    const oneFile = attempt({}, { attachments: [fileAttachment("a")] });
    const image = message({
      blocks: [
        { kind: "text", text: "hello" },
        { kind: "image", artifactId: "a", mimeType: "image/png", name: "a.png" },
      ],
    });
    expect(matchesInFlightEcho(oneFile, image, "user-1")).toBe(true);
    expect(matchesInFlightEcho(attempt(), image, "user-1")).toBe(false);
  });

  it("only ever explains a pending send the server has not answered", () => {
    expect(matchesInFlightEcho(attempt({ state: "queued" }), message(), "user-1")).toBe(false);
    expect(matchesInFlightEcho(attempt({ state: "failed" }), message(), "user-1")).toBe(false);
    expect(matchesInFlightEcho(attempt({ acceptedSeq: 4 }), message(), "user-1")).toBe(false);
    expect(matchesInFlightEcho(attempt(), message({ role: "bot" }), "user-1")).toBe(false);
  });
});

describe("claimed echos", () => {
  it("remembers which send claimed an echoed message until the queue is cleared", () => {
    expect(webEchoMessageOwner("m-1")).toBeUndefined();
    claimWebEchoMessage("m-1", "nonce-1");
    expect(webEchoMessageOwner("m-1")).toBe("nonce-1");
    // A second send cannot take it: the map names the one that did.
    claimWebEchoMessage("m-1", "nonce-2");
    expect(webEchoMessageOwner("m-1")).toBe("nonce-2");

    clearWebOutbox();
    expect(webEchoMessageOwner("m-1")).toBeUndefined();
  });
});
