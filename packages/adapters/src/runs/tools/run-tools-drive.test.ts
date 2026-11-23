import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "../assembly/run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { driveTools } from "./run-tools-drive.js";

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    name,
    args,
    executionId: "exec-1",
    finish: (result: unknown) => result,
  } as unknown as ToolCall;
}

describe("driveTools", () => {
  it("lists non-trashed folders and deduplicates latest file versions", async () => {
    const findFolders = vi.fn().mockResolvedValue([
      {
        id: "fold-1",
        parentId: null,
        name: "Videos",
        updatedAt: new Date("2026-11-22T00:00:00Z"),
      },
    ]);
    const findArtifacts = vi.fn().mockResolvedValue([
      {
        id: "art-v2",
        folderId: null,
        botId: "bot-1",
        source: "bot",
        name: "deploy.sh",
        description: null,
        mimeType: "application/x-sh",
        size: 40,
        version: 2,
        rootArtifactId: "art-v1",
        updatedAt: new Date("2026-11-22T01:00:00Z"),
      },
      {
        id: "art-v1",
        folderId: null,
        botId: "bot-1",
        source: "bot",
        name: "deploy.sh",
        description: null,
        mimeType: "application/x-sh",
        size: 20,
        version: 1,
        rootArtifactId: null,
        updatedAt: new Date("2026-11-22T00:00:00Z"),
      },
    ]);
    const ctx = {
      bot: { id: "bot-1" },
      run: { spaceId: "space-1", userId: "user-1", id: "run-1" },
      secrets: [],
      context: { signal: new AbortController().signal },
      deps: {
        prisma: {
          fileFolder: { findMany: findFolders },
          artifact: { findMany: findArtifacts },
        },
      },
    } as unknown as RunContext;

    const result = (await driveTools.drive_list!(
      ctx,
      makeCall("drive_list", { category: "code" }),
    )) as {
      folders: unknown[];
      files: Array<{ id: string; version: number }>;
    };
    expect(result.folders).toHaveLength(1);
    expect(result.files).toEqual([expect.objectContaining({ id: "art-v2", version: 2 })]);
  });

  it("reads text preview with redaction and copies large binary files to workspace", async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({
        id: "f-sh",
        name: "setup.sh",
        mimeType: "application/x-sh",
        size: 28,
        storageKey: "blob-sh",
        folderId: null,
        version: 1,
      })
      .mockResolvedValueOnce({
        id: "f-mp4",
        name: "clip.mp4",
        mimeType: "video/mp4",
        size: 30_000_000,
        storageKey: "blob-mp4",
        folderId: null,
        version: 1,
      });
    const get = vi
      .fn()
      .mockResolvedValueOnce(new TextEncoder().encode("echo SECRET_TOKEN_123"))
      .mockResolvedValueOnce(new Uint8Array([0, 0, 0, 24]));
    const ctx = {
      bot: { id: "bot-1" },
      run: { spaceId: "space-1", userId: "user-1", id: "run-1" },
      secrets: ["SECRET_TOKEN_123"],
      computer: { mode: "team", get: vi.fn().mockResolvedValue({ providerRef: "sb-1" }) },
      context: { signal: new AbortController().signal },
      deps: {
        prisma: { artifact: { findFirst } },
        artifacts: { get },
        sandbox: { writeFile },
      },
    } as unknown as RunContext;

    const preview = (await driveTools.drive_read!(
      ctx,
      makeCall("drive_read", { file_id: "f-sh" }),
    )) as {
      content: string;
    };
    expect(preview.content).not.toContain("SECRET_TOKEN_123");

    const copied = (await driveTools.drive_read!(
      ctx,
      makeCall("drive_read", { file_id: "f-mp4", save_to_workspace: "videos/clip.mp4" }),
    )) as { ok: boolean; savedTo: string };
    expect(copied).toMatchObject({ ok: true, savedTo: "videos/clip.mp4" });
    expect(writeFile).toHaveBeenCalledOnce();
  });

  it("saves inline text scripts into Space Drive with version resolution", async () => {
    const put = vi.fn().mockResolvedValue({ id: "blob-new", hash: "abc" });
    const create = vi.fn().mockImplementation(async ({ data }) => ({
      id: "art-new",
      ...data,
    }));
    const publishSpaceChange = vi.fn().mockResolvedValue(undefined);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      artifact: {
        findFirst: vi.fn().mockResolvedValue(null),
        create,
      },
    };
    const ctx = {
      bot: { id: "bot-1" },
      thread: { id: "thread-1", groupId: null },
      source: {},
      run: { spaceId: "space-1", userId: "user-1", id: "run-1" },
      secrets: [],
      context: { signal: new AbortController().signal },
      deps: {
        prisma: {
          $transaction: vi.fn().mockImplementation(async (fn) => fn(tx)),
        },
        artifacts: { put, remove: vi.fn() },
        events: { publishSpaceChange },
      },
    } as unknown as RunContext;

    const saved = (await driveTools.drive_save!(
      ctx,
      makeCall("drive_save", { name: "build.sh", content: "#!/bin/sh\necho hi\n" }),
    )) as { ok: boolean; fileId: string; mimeType: string };
    expect(saved).toMatchObject({ ok: true, fileId: "art-new", mimeType: "application/x-sh" });
    expect(create.mock.calls[0]![0].data).toMatchObject({
      source: "bot",
      mimeType: "application/x-sh",
    });
    expect(publishSpaceChange).toHaveBeenCalledWith("space-1", "files");
  });

  it("auto-places drive_save in the bot folder with a slug and supports drive_create_folder, drive_move, and drive_update", async () => {
    const publishSpaceChange = vi.fn();
    const put = vi.fn().mockResolvedValue({ id: "blob-2", hash: "hash-2" });
    const createFolder = vi
      .fn()
      .mockResolvedValueOnce({ id: "bot-folder-1", name: "Ops Bot" })
      .mockResolvedValueOnce({
        id: "folder-dest",
        name: "Specs",
        parentId: null,
      });
    const createArtifact = vi.fn().mockResolvedValue({
      id: "file-2",
      name: "deploy-notes.md",
      slug: "deploy-notes",
      description: "Deploy checklist",
      folderId: "bot-folder-1",
      mimeType: "text/markdown",
      size: 12,
      version: 1,
      updatedAt: new Date("2026-11-23T00:00:00.000Z"),
    });
    const updateManyArtifact = vi.fn().mockResolvedValue({ count: 1 });
    const fileFolder = {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "folder-dest", trashedAt: null }),
      updateMany: vi.fn(),
      create: createFolder,
    };
    const botModel = {
      findFirst: vi.fn().mockResolvedValue({ name: "Ops Bot", userId: "user-1" }),
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      artifact: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: "file-2", rootArtifactId: null, trashedAt: null })
          .mockResolvedValueOnce({
            id: "file-2",
            name: "deploy-renamed.md",
            slug: "deploy-v2",
            description: "Updated checklist",
            folderId: "folder-dest",
            version: 1,
          }),
        updateMany: updateManyArtifact,
        create: createArtifact,
      },
      fileFolder,
      bot: botModel,
    };
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = {
      artifact: {
        findMany,
        findFirst: tx.artifact.findFirst,
        updateMany: updateManyArtifact,
      },
      fileFolder,
      bot: botModel,
      $transaction: vi.fn().mockImplementation(async (fn) => fn(tx)),
    };
    const ctx = {
      bot: { id: "bot-1" },
      thread: { id: "thread-1", groupId: null },
      source: {},
      run: { spaceId: "space-1", userId: "user-1", id: "run-1" },
      secrets: [],
      context: { signal: new AbortController().signal },
      deps: {
        prisma,
        artifacts: { put, remove: vi.fn() },
        events: { publishSpaceChange },
      },
    } as unknown as RunContext;

    const saved = (await driveTools.drive_save!(
      ctx,
      makeCall("drive_save", {
        name: "deploy-notes.md",
        description: "Deploy checklist",
        content: "# Checklist",
      }),
    )) as { folderId: string | null; slug: string | null };
    expect(saved).toMatchObject({ folderId: "bot-folder-1", slug: "deploy-notes" });
    expect(createFolder).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ botId: "bot-1", name: "Ops Bot" }),
      }),
    );

    const createdFolder = (await driveTools.drive_create_folder!(
      ctx,
      makeCall("drive_create_folder", { name: "Specs" }),
    )) as { ok: boolean; created: boolean; folder: { id: string; name: string } };
    expect(createdFolder).toMatchObject({
      ok: true,
      created: true,
      folder: { id: "folder-dest", name: "Specs" },
    });

    const moved = (await driveTools.drive_move!(
      ctx,
      makeCall("drive_move", { file_id: "file-2", destination_folder_id: "folder-dest" }),
    )) as { ok: boolean; fileId: string; folderId: string | null };
    expect(moved).toMatchObject({ ok: true, fileId: "file-2", folderId: "folder-dest" });

    const updated = (await driveTools.drive_update!(
      ctx,
      makeCall("drive_update", {
        file_id: "file-2",
        name: "deploy-renamed.md",
        slug: "Deploy v2",
        description: "Updated checklist",
      }),
    )) as { ok: boolean; name: string; slug: string | null; description: string | null };
    expect(updated).toMatchObject({
      ok: true,
      name: "deploy-renamed.md",
      slug: "deploy-v2",
      description: "Updated checklist",
    });

    await driveTools.drive_list!(
      ctx,
      makeCall("drive_list", { query: "deploy-v2", bot_id: "bot-2" }),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: "bot-2",
          OR: expect.arrayContaining([
            expect.objectContaining({ slug: { contains: "deploy-v2", mode: "insensitive" } }),
          ]),
        }),
      }),
    );
  });
});
