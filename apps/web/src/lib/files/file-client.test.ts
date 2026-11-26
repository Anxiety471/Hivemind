// @vitest-environment jsdom
import { isServerUnreachable } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isServerReachable, resetServerReachableForTests } from "../query/connection-state";
import { errorText } from "../query/user-error";
import { uploadSpaceFile } from "./file-client";

const createArtifact = vi.hoisted(() => vi.fn());
const selectedSpaceId = vi.hoisted(() => vi.fn((): string | null => "space-selected"));

vi.mock("../query/rpc", () => ({
  rpc: { artifacts: { create: createArtifact } },
  selectedSpaceId: () => selectedSpaceId(),
}));
vi.mock("../bootstrap", () => ({ getMaxUploadSizeBytes: () => 5_000_000 }));

/** One request at a time: the newest fake answers for the upload the test just started. */
class FakeXhr {
  static last: FakeXhr | undefined;

  status = 0;
  responseText = "";
  timeout = 0;
  withCredentials = false;
  readonly headers = new Map<string, string>();
  readonly upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private responseHeaders: Record<string, string> = {};

  constructor() {
    FakeXhr.last = this;
  }

  open() {}

  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value);
  }

  getResponseHeader(name: string) {
    return this.responseHeaders[name] ?? null;
  }

  abort() {}

  send() {}

  respond(status: number, body = "", headers: Record<string, string> = {}) {
    this.status = status;
    this.responseText = body;
    this.responseHeaders = headers;
    this.onload?.();
  }
}

function startUpload(options: { botId?: string; spaceId?: string | null } = {}) {
  const file = new File(["hello"], "example.txt", { type: "text/plain" });
  const pending = uploadSpaceFile({ file, botId: "bot-1", ...options });
  const xhr = FakeXhr.last;
  if (!xhr) throw new Error("The upload never opened a request");
  return { pending, xhr };
}

beforeEach(() => {
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  FakeXhr.last = undefined;
  createArtifact.mockReset();
  createArtifact.mockResolvedValue({
    id: "artifact-1",
    name: "example.txt",
    mimeType: "text/plain",
    size: 5,
  });
  selectedSpaceId.mockClear();
  resetServerReachableForTests(true);
});

describe("upload failures", () => {
  it.each([
    [201, true],
    [400, true],
    [429, true],
    [502, false],
    [503, false],
    [504, false],
  ])("keeps the status and Retry-After of a %i answer", async (status, reachable) => {
    resetServerReachableForTests(!reachable);
    const { pending, xhr } = startUpload();

    if (status >= 200 && status < 300) {
      xhr.respond(status, JSON.stringify({ id: "artifact-1", name: "x", mimeType: "text/plain" }));
      await expect(pending).resolves.toMatchObject({ id: "artifact-1" });
    } else {
      xhr.respond(status, "<html>proxy</html>", { "retry-after": "30" });
      const error = await pending.catch((cause: unknown) => cause);
      expect(error).toMatchObject({ status, retryAfterMs: 30_000 });
    }
    expect(isServerReachable()).toBe(reachable);
  });

  it("rejects a lost connection as unreachable, with copy for the user", async () => {
    const { pending, xhr } = startUpload();

    xhr.onerror?.();

    const error = await pending.catch((cause: unknown) => cause);
    expect(isServerUnreachable(error)).toBe(true);
    expect(isServerReachable()).toBe(false);
    expect(errorText(error)).toBe("Could not reach the server");
  });

  it("rejects a timed-out upload as unreachable", async () => {
    const { pending, xhr } = startUpload();

    xhr.ontimeout?.();

    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toMatchObject({ name: "TimeoutError" });
    expect(isServerUnreachable(error)).toBe(true);
    expect(isServerReachable()).toBe(false);
  });

  it("stops uploading after a minute", () => {
    startUpload();
    expect(FakeXhr.last?.timeout).toBe(60_000);
  });
});

describe("upload space", () => {
  it.each([
    ["space-2", "space-2"],
    [null, null],
  ] as const)(
    "sends an explicit space %s on the request and the fallback",
    async (spaceId, sent) => {
      const { pending, xhr } = startUpload({ spaceId });
      expect(xhr.headers.get("x-rakazo-space-id") ?? null).toBe(sent);
      expect(selectedSpaceId).not.toHaveBeenCalled();

      xhr.respond(404);
      await expect(pending).resolves.toMatchObject({ id: "artifact-1" });
      expect(createArtifact).toHaveBeenCalledWith(expect.objectContaining({ botId: "bot-1" }), {
        context: { spaceId: sent },
      });
    },
  );

  it("uses the selected space when the caller does not name one", async () => {
    const { pending, xhr } = startUpload();
    expect(xhr.headers.get("x-rakazo-space-id")).toBe("space-selected");

    xhr.respond(404);
    await pending;
    expect(createArtifact).toHaveBeenCalledWith(expect.anything(), {
      context: { spaceId: "space-selected" },
    });
  });
});
