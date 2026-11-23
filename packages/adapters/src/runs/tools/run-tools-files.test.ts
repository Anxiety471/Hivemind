import { SandboxFileTooLargeError, SandboxProviderAccountError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "../assembly/run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { fileTools } from "./run-tools-files.js";

function setup() {
  const stored = {
    id: "computer-1",
    homeKey: "home-1",
    scope: "team",
    kind: "boat",
    providerRef: "sandbox-1",
    screenGeneration: 5,
    homeRevision: "revision-1",
    homeRevisionAt: new Date(),
  };
  const findFirst = vi.fn().mockResolvedValue(stored);
  const readStoppedFile = vi.fn().mockResolvedValue(new TextEncoder().encode("saved SECRET"));
  const readFile = vi.fn().mockResolvedValue(new TextEncoder().encode("live contents"));
  const get = vi.fn().mockResolvedValue(stored);
  const controller = new AbortController();
  const ctx = {
    bot: { id: "bot-1" },
    run: { spaceId: "space-1" },
    computer: { stored, kind: stored.kind, mode: "team", lazy: {}, get },
    context: { signal: controller.signal },
    deps: { prisma: { computer: { findFirst } }, sandbox: { readStoppedFile, readFile } },
    secrets: ["SECRET"],
  } as unknown as RunContext;
  const read = (path: string) =>
    fileTools.read_file!(ctx, { name: "read_file", args: { path } } as unknown as ToolCall);
  return { read, readStoppedFile, get, findFirst, stored, controller };
}

describe("read_file with a suspended computer", () => {
  it("returns redacted text from the stopped disk without claiming the computer", async () => {
    const { read, readStoppedFile, get, findFirst, stored } = setup();
    const result = await read("notes.txt");
    expect(result).toMatchObject({ path: "notes.txt", totalLines: 1 });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(readStoppedFile).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: stored.providerRef }),
      "notes.txt",
      expect.anything(),
      expect.objectContaining({ savedAt: stored.homeRevisionAt }),
    );
    expect(findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: "suspended",
          screenGeneration: stored.screenGeneration,
        }),
      }),
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("discards saved bytes if the computer changes before the read returns", async () => {
    const { read, findFirst, get, stored } = setup();
    findFirst.mockResolvedValueOnce(stored).mockResolvedValueOnce(null);
    await expect(read("notes.txt")).resolves.toMatchObject({ content: "live contents" });
    expect(get).toHaveBeenCalledOnce();
  });

  it("uses the live reader when the provider's optional snapshot read fails", async () => {
    const { read, readStoppedFile, get } = setup();
    readStoppedFile.mockRejectedValueOnce(new SandboxProviderAccountError());
    await expect(read("notes.txt")).resolves.toMatchObject({ content: "live contents" });
    expect(get).toHaveBeenCalledOnce();
  });

  it("does not wake the computer if the run is cancelled during the snapshot read", async () => {
    const { read, readStoppedFile, get, controller } = setup();
    readStoppedFile.mockImplementationOnce(async () => {
      controller.abort();
      controller.signal.throwIfAborted();
    });
    await expect(read("notes.txt")).rejects.toMatchObject({ name: "AbortError" });
    expect(get).not.toHaveBeenCalled();
  });

  it("reports a verified oversized file without waking, and retries if the computer changed", async () => {
    const { read, readStoppedFile, findFirst, get, stored } = setup();
    const tooLarge = new SandboxFileTooLargeError(250_000);
    readStoppedFile.mockRejectedValueOnce(tooLarge);
    await expect(read("notes.txt")).resolves.toMatchObject({
      error: expect.stringContaining("file is over"),
    });
    expect(get).not.toHaveBeenCalled();

    readStoppedFile.mockRejectedValueOnce(tooLarge);
    findFirst.mockResolvedValueOnce(stored).mockResolvedValueOnce(null);
    await expect(read("notes.txt")).resolves.toMatchObject({ content: "live contents" });
    expect(get).toHaveBeenCalledOnce();
  });

  it("uses the live computer to materialize attachments before reading", async () => {
    const { read, findFirst, get } = setup();
    await expect(read("attachments/upload.txt")).resolves.toMatchObject({
      content: "live contents",
    });
    expect(findFirst).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledOnce();
  });
});

describe("write_file and attach_file Space Drive defaults", () => {
  it("rejects writing under per-bot bots/<id>/ subtrees on a team computer", async () => {
    const writeFile = vi.fn();
    const markDirty = vi.fn();
    const get = vi.fn().mockResolvedValue({ id: "computer-1", kind: "docker" });
    const finish = vi.fn((result: unknown) => result);
    const ctx = {
      bot: { id: "bot-1" },
      run: { id: "run-1", spaceId: "space-1", userId: "user-1", trigger: "user" },
      computer: {
        mode: "team",
        kind: "docker",
        held: false,
        lazy: {},
        get,
        checkpoint: { markDirty },
      },
      context: { signal: new AbortController().signal },
      deps: { sandbox: { writeFile } },
    } as unknown as RunContext;

    for (const badPath of ["bots/bot-1/note.txt", "~/bots/bot-1/note.txt"]) {
      const result = await fileTools.write_file!(ctx, {
        name: "write_file",
        args: { path: badPath, content: "hello" },
        finish,
      } as unknown as ToolCall);
      expect(result).toMatchObject({
        error: expect.stringContaining("Space Drive"),
        path: badPath,
      });
    }
    expect(markDirty).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("allows writing under bots/ on a dedicated private computer", async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const append = vi.fn().mockResolvedValue(undefined);
    const markDirty = vi.fn();
    const get = vi.fn().mockResolvedValue({ id: "computer-priv", kind: "docker" });
    const finish = vi.fn((result: unknown) => result);
    const ctx = {
      bot: { id: "bot-x" },
      runId: "run-1",
      run: { id: "run-1", spaceId: "space-1", userId: "user-1", trigger: "user" },
      thread: { id: "t-1", groupId: null },
      computer: {
        mode: "dedicated",
        kind: "docker",
        held: false,
        lazy: {},
        get,
        checkpoint: { markDirty },
      },
      source: {},
      secrets: [],
      context: { signal: new AbortController().signal },
      deps: { sandbox: { writeFile }, events: { append } },
    } as unknown as RunContext;

    const result = await fileTools.write_file!(ctx, {
      name: "write_file",
      executionId: "exec-priv",
      args: { path: "bots/x-scout/out/test.json", content: "{}" },
      finish,
    } as unknown as ToolCall);
    expect(result).toEqual({ ok: true, path: "bots/x-scout/out/test.json" });
    expect(markDirty).toHaveBeenCalledOnce();
    expect(writeFile).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledOnce();
  });

  it("forwards custom slug from attach_file into Space Drive", async () => {
    const artifact = {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }) => ({
        id: "art-1",
        ...data,
      })),
    };
    const fileFolder = { findFirst: vi.fn().mockResolvedValue({ id: "folder-bot-1" }) };
    const messageCreate = vi.fn(async () => ({ eventSeq: 1 }));
    const tx = {
      artifact,
      fileFolder,
      message: { create: messageCreate },
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    const ctx = {
      bot: { id: "bot-1" },
      runId: "run-1",
      run: {
        id: "run-1",
        spaceId: "space-1",
        userId: "user-1",
        threadId: "t-1",
        trigger: "tickets",
      },
      thread: { id: "t-1", groupId: null },
      source: { conversationThreadId: "t-1" },
      secrets: [],
      computer: {
        mode: "team",
        kind: "docker",
        held: false,
        lazy: {},
        get: vi.fn().mockResolvedValue({ id: "computer-1", kind: "docker" }),
      },
      context: { signal: new AbortController().signal },
      deps: {
        prisma: {
          artifact,
          fileFolder,
          $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
        },
        artifacts: {
          put: vi.fn().mockResolvedValue({ id: "blob-1" }),
          remove: vi.fn().mockResolvedValue(undefined),
        },
        sandbox: { readFile: vi.fn().mockResolvedValue(new TextEncoder().encode("report body")) },
        events: {
          append: vi.fn().mockResolvedValue(undefined),
          notify: vi.fn().mockResolvedValue(undefined),
          publishSpaceChange: vi.fn(),
        },
      },
    } as unknown as RunContext;

    const finish = vi.fn((result: unknown) => result);
    const result = await fileTools.attach_file!(ctx, {
      name: "attach_file",
      executionId: "exec-1",
      args: {
        path: "reports/q4.md",
        name: "Q4 Report.md",
        description: "Quarterly summary",
        slug: "q4-custom-slug",
      },
      finish,
    } as unknown as ToolCall);

    expect(result).toMatchObject({ ok: true, artifactId: "art-1", path: "reports/q4.md" });
    expect(artifact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          slug: "q4-custom-slug",
          folderId: "folder-bot-1",
          description: "Quarterly summary",
        }),
      }),
    );
  });
});
