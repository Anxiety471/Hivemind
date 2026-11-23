import { createHash } from "node:crypto";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { fileErrorStatus, openMultipartParts } from "../http/files-routes.js";
import {
  createDriveFolder,
  DriveFileTooLargeError,
  DriveNotFoundError,
  DriveValidationError,
  deleteDriveFilePermanent,
  deleteDriveFolderPermanent,
  emptyDriveTrash,
  formatContentDisposition,
  getDriveFile,
  isSafeInlineMedia,
  listDriveChanges,
  listDriveFiles,
  matchesIfNoneMatch,
  moveDriveFolder,
  openSpaceFileContent,
  parseSingleByteRange,
  renameDriveFolder,
  restoreDriveFile,
  restoreDriveFolder,
  statSpaceFileContent,
  trashDriveFile,
  trashDriveFolder,
  updateDriveFile,
  uploadSpaceFileStream,
} from "./files/index.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.com",
  isDeploymentOwner: false,
};

type ArtifactRow = {
  id: string;
  spaceId: string;
  userId: string;
  botId: string | null;
  groupId: string | null;
  folderId: string | null;
  runId: string | null;
  source: string;
  name: string;
  slug: string | null;
  description: string | null;
  mimeType: string;
  size: number;
  hash: string;
  storageKey: string;
  trashedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  rootArtifactId: string | null;
  version: number;
  standalone: boolean;
  clientNonce: string | null;
};

type FolderRow = {
  id: string;
  spaceId: string;
  parentId: string | null;
  botId: string | null;
  createdByUserId: string;
  name: string;
  trashedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type Where = Record<string, unknown>;

function matchesWhere(row: Record<string, unknown>, where: Where): boolean {
  for (const [key, expected] of Object.entries(where)) {
    if (key === "OR") {
      if (!(expected as Where[]).some((clause) => matchesWhere(row, clause))) return false;
      continue;
    }
    const actual = row[key];
    if (expected === null) {
      if (actual !== null && actual !== undefined) return false;
      continue;
    }
    if (typeof expected === "object" && expected !== null) {
      const filter = expected as Record<string, unknown>;
      if ("equals" in filter) {
        const mode = filter.mode;
        const want = filter.equals;
        const left =
          typeof want === "string" && mode === "insensitive"
            ? String(actual ?? "").toLowerCase()
            : actual;
        const right =
          typeof want === "string" && mode === "insensitive" ? want.toLowerCase() : want;
        if (left !== right) return false;
      }
      if ("not" in filter && actual === filter.not) return false;
      if ("in" in filter && !(filter.in as unknown[]).includes(actual)) return false;
      if ("notIn" in filter && (filter.notIn as unknown[]).includes(actual)) return false;
      if ("contains" in filter) {
        const hay = String(actual ?? "");
        const needle = String(filter.contains);
        const found =
          filter.mode === "insensitive"
            ? hay.toLowerCase().includes(needle.toLowerCase())
            : hay.includes(needle);
        if (!found) return false;
      }
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function orderRows<T extends Record<string, unknown>>(rows: T[], orderBy: unknown): T[] {
  const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  if (clauses.length === 0) return rows;
  return [...rows].sort((left, right) => {
    for (const clause of clauses as Array<Record<string, "asc" | "desc">>) {
      for (const [field, direction] of Object.entries(clause)) {
        const a = left[field];
        const b = right[field];
        if (a === b) continue;
        const comparison = (a as number | Date) < (b as number | Date) ? -1 : 1;
        return direction === "desc" ? -comparison : comparison;
      }
    }
    return 0;
  });
}

type MemoryStore = {
  store: ArtifactStore;
  blobs: Map<string, Uint8Array>;
  removed: string[];
  sequence: () => number;
};

function memoryStore(): MemoryStore {
  const blobs = new Map<string, Uint8Array>();
  const removed: string[] = [];
  let sequence = 0;
  const store: ArtifactStore = {
    describe: () => ({
      id: "memory",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { stream: true },
    }),
    put: async ({ bytes }) => {
      const id = `blob-${++sequence}`;
      blobs.set(id, bytes);
      return { id, hash: String(bytes.byteLength) };
    },
    get: async (id) => {
      const bytes = blobs.get(id);
      if (!bytes) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return bytes;
    },
    remove: async (id) => {
      blobs.delete(id);
      removed.push(id);
    },
    putStream: vi.fn(async ({ stream }) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of stream) {
        chunks.push(chunk);
        size += chunk.byteLength;
      }
      const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      const id = `blob-${++sequence}`;
      blobs.set(id, new Uint8Array(bytes));
      return {
        id,
        hash: createHash("sha256").update(bytes).digest("hex"),
        size,
      };
    }),
    getStream: async (id, _context, options) => {
      const all = blobs.get(id);
      if (!all) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      const range = options?.range;
      const bytes = range
        ? all.subarray(range.start, Math.min(range.endInclusive + 1, all.byteLength))
        : all;
      const middle = Math.floor(bytes.byteLength / 2);
      return (async function* () {
        if (middle > 0) yield bytes.subarray(0, middle);
        if (bytes.byteLength > 0) yield bytes.subarray(middle);
      })();
    },
  };
  return { store, blobs, removed, sequence: () => sequence };
}

function artifactRow(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  const id = overrides.id ?? `art-${overrides.name ?? "file"}`;
  return {
    id,
    spaceId: "space-1",
    userId: "user-1",
    botId: null,
    groupId: null,
    folderId: null,
    runId: null,
    source: "upload",
    name: "file.txt",
    slug: null,
    description: null,
    mimeType: "text/plain",
    size: 10,
    hash: `hash-${id}`,
    storageKey: `blob-${id}`,
    trashedAt: null,
    createdAt: new Date("2026-11-01T00:00:00.000Z"),
    updatedAt: new Date("2026-11-01T00:00:00.000Z"),
    rootArtifactId: null,
    version: 1,
    standalone: false,
    clientNonce: null,
    ...overrides,
  };
}

function folderRow(overrides: Partial<FolderRow> = {}): FolderRow {
  const id = overrides.id ?? `folder-${overrides.name ?? "one"}`;
  return {
    id,
    spaceId: "space-1",
    parentId: null,
    botId: null,
    createdByUserId: "user-1",
    name: "folder",
    trashedAt: null,
    createdAt: new Date("2026-11-01T00:00:00.000Z"),
    updatedAt: new Date("2026-11-01T00:00:00.000Z"),
    ...overrides,
  };
}

type RawQuery = { strings: string[]; values: unknown[] };

type FakeDrive = {
  prisma: PrismaClient;
  artifacts: ArtifactRow[];
  folders: FolderRow[];
  rawQueries: RawQuery[];
};

function fakeDrive(
  seed: {
    artifacts?: ArtifactRow[];
    folders?: FolderRow[];
    bots?: string[];
    botName?: string;
    groups?: string[];
    failCreate?: boolean;
    /** Rows returned by successive list queries, as the database would page them. */
    listResults?: unknown[][];
    /** Rows returned by successive changes queries. */
    changeResults?: unknown[][];
  } = {},
): FakeDrive {
  const artifacts = [...(seed.artifacts ?? [])];
  const folders = [...(seed.folders ?? [])];
  const listResults = [...(seed.listResults ?? [])];
  const changeResults = [...(seed.changeResults ?? [])];
  const rawQueries: RawQuery[] = [];
  let folderSequence = 0;
  let artifactSequence = 0;
  const uniqueFolder = (candidate: Partial<FolderRow>, excludeId?: string) =>
    folders.some(
      (row) =>
        row.id !== excludeId &&
        row.spaceId === candidate.spaceId &&
        row.trashedAt === null &&
        (row.parentId ?? null) === (candidate.parentId ?? null) &&
        row.name.toLowerCase() === String(candidate.name ?? "").toLowerCase(),
    );
  const artifact = {
    findFirst: async ({ where, orderBy }: { where: Where; orderBy?: unknown }) => {
      const rows = orderRows(
        artifacts.filter((row) => matchesWhere(row as unknown as Where, where)),
        orderBy,
      );
      return rows[0] ?? null;
    },
    findMany: async ({ where, orderBy }: { where: Where; orderBy?: unknown }) =>
      orderRows(
        artifacts.filter((row) => matchesWhere(row as unknown as Where, where)),
        orderBy,
      ),
    create: async ({ data }: { data: Partial<ArtifactRow> }) => {
      if (seed.failCreate) throw Object.assign(new Error("unique"), { code: "P2002" });
      const row = {
        ...artifactRow(),
        ...data,
        id: `art-${++artifactSequence}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        trashedAt: null,
        standalone: false,
        clientNonce: data.clientNonce ?? null,
      } as ArtifactRow;
      artifacts.push(row);
      return row;
    },
    updateMany: async ({ where, data }: { where: Where; data: Partial<ArtifactRow> }) => {
      const matching = artifacts.filter((row) => matchesWhere(row as unknown as Where, where));
      for (const row of matching) Object.assign(row, data);
      return { count: matching.length };
    },
  };
  const fileFolder = {
    findFirst: async ({ where, orderBy }: { where: Where; orderBy?: unknown }) => {
      const rows = orderRows(
        folders.filter((row) => matchesWhere(row as unknown as Where, where)),
        orderBy,
      );
      return rows[0] ?? null;
    },
    findMany: async ({ where, orderBy }: { where: Where; orderBy?: unknown }) =>
      orderRows(
        folders.filter((row) => matchesWhere(row as unknown as Where, where)),
        orderBy,
      ),
    create: async ({ data }: { data: Partial<FolderRow> }) => {
      if (uniqueFolder(data)) throw Object.assign(new Error("unique"), { code: "P2002" });
      const row = {
        ...folderRow(),
        ...data,
        id: `folder-${++folderSequence}`,
        trashedAt: data.trashedAt ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as FolderRow;
      folders.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<FolderRow> }) => {
      const row = folders.find((candidate) => candidate.id === where.id);
      if (!row) throw Object.assign(new Error("missing"), { code: "P2025" });
      if (data.name !== undefined || data.parentId !== undefined) {
        const candidate = { ...row, ...data };
        if (uniqueFolder(candidate, where.id)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
      }
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
    updateMany: async ({ where, data }: { where: Where; data: Partial<FolderRow> }) => {
      const matching = folders.filter((row) => matchesWhere(row as unknown as Where, where));
      for (const row of matching) Object.assign(row, data);
      return { count: matching.length };
    },
    deleteMany: async ({ where }: { where: Where }) => {
      const keep = folders.filter((row) => !matchesWhere(row as unknown as Where, where));
      const count = folders.length - keep.length;
      folders.splice(0, folders.length, ...keep);
      return { count };
    },
  };
  const $queryRaw = async (query: RawQuery) => {
    rawQueries.push(query);
    const text = query.strings.join(" ");
    if (text.includes("pg_advisory_xact_lock")) return [];
    if (text.includes("WITH families")) return listResults.shift() ?? [];
    if (text.includes("WITH combined")) return changeResults.shift() ?? [];
    if (!text.includes('DELETE FROM "artifacts"'))
      throw new Error(`Unexpected raw query in fake: ${text}`);
    const spaceId = query.values[0] as string;
    let predicate: (row: ArtifactRow) => boolean;
    if (text.includes('"folderId" IN')) {
      const ids = query.values.slice(1) as string[];
      predicate = (row) => row.spaceId === spaceId && ids.includes(row.folderId ?? "");
    } else if (text.includes('"rootArtifactId"')) {
      const root = query.values[1] as string;
      predicate = (row) =>
        row.spaceId === spaceId && (row.id === root || row.rootArtifactId === root);
    } else {
      predicate = (row) => row.spaceId === spaceId && row.trashedAt !== null;
    }
    const removed = artifacts.filter(predicate);
    artifacts.splice(0, artifacts.length, ...artifacts.filter((row) => !predicate(row)));
    return removed.map((row) => ({ storageKey: row.storageKey }));
  };
  const prisma = {
    artifact,
    fileFolder,
    bot: {
      findFirst: async ({ where }: { where: Where }) =>
        (seed.bots ?? []).includes(String(where.id))
          ? { id: where.id, name: seed.botName ?? "Bot", userId: "user-1" }
          : null,
    },
    chatGroup: {
      findFirst: async ({ where }: { where: Where }) =>
        (seed.groups ?? []).includes(String(where.id)) ? { id: where.id } : null,
    },
    $queryRaw,
    $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        artifact,
        fileFolder,
        bot: {
          findFirst: async ({ where }: { where: Where }) =>
            (seed.bots ?? []).includes(String(where.id))
              ? { id: where.id, name: seed.botName ?? "Bot", userId: "user-1" }
              : null,
        },
        $queryRaw,
      }),
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    artifacts,
    folders,
    rawQueries,
  };
}

function depsFor(fake: FakeDrive, maxFileUploadSizeBytes?: number) {
  const memory = memoryStore();
  for (const row of fake.artifacts) {
    memory.blobs.set(row.storageKey, Buffer.from(`seeded ${row.storageKey}`));
  }
  return {
    deps: {
      prisma: fake.prisma,
      artifacts: memory.store,
      ...(maxFileUploadSizeBytes === undefined ? {} : { maxFileUploadSizeBytes }),
    },
    memory,
  };
}

function streamOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield bytes;
  })();
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("uploadSpaceFileStream", () => {
  it("stores bytes with a sha256 hash and a stable content URL", async () => {
    const fake = fakeDrive();
    const { deps, memory } = depsFor(fake);
    const bytes = Buffer.concat([Buffer.from(PNG_MAGIC), Buffer.from("raster")]);
    const file = await uploadSpaceFileStream(
      deps,
      actor,
      { name: "shot.png", mimeType: "image/png", description: "  A shot  " },
      streamOf(bytes),
    );

    expect(file).toMatchObject({
      name: "shot.png",
      mimeType: "image/png",
      description: "A shot",
      size: bytes.byteLength,
      version: 1,
      versionCount: 1,
      source: "upload",
      folderId: null,
      trashedAt: null,
      contentUrl: `/api/v1/files/${file.id}/content`,
    });
    expect(file.hash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect([...memory.blobs.values()]).toEqual([new Uint8Array(bytes)]);
  });

  it("resolves the next version for the same folder and name", async () => {
    const fake = fakeDrive();
    const { deps } = depsFor(fake);
    const first = await uploadSpaceFileStream(
      deps,
      actor,
      { name: "notes.txt", mimeType: "text/plain" },
      streamOf(new TextEncoder().encode("one")),
    );
    const second = await uploadSpaceFileStream(
      deps,
      actor,
      { name: "notes.txt", mimeType: "text/plain" },
      streamOf(new TextEncoder().encode("two")),
    );
    expect(second.version).toBe(2);
    expect(second.versionCount).toBe(2);
    expect(fake.artifacts.find((row) => row.id === second.id)?.rootArtifactId).toBe(first.id);
  });

  it("returns the row a retried clientNonce already created without storing again", async () => {
    const fake = fakeDrive();
    const { deps, memory } = depsFor(fake);
    const params = { name: "once.txt", mimeType: "text/plain", clientNonce: "nonce-1" };
    const first = await uploadSpaceFileStream(
      deps,
      actor,
      params,
      streamOf(new TextEncoder().encode("payload")),
    );
    const second = await uploadSpaceFileStream(
      deps,
      actor,
      params,
      streamOf(new TextEncoder().encode("payload")),
    );
    expect(second.id).toBe(first.id);
    expect(memory.store.putStream).toHaveBeenCalledOnce();
    expect(memory.blobs.size).toBe(1);
  });

  it("rejects markup disguised as video and blocked executables before storing", async () => {
    const fake = fakeDrive();
    const { deps, memory } = depsFor(fake);
    await expect(
      uploadSpaceFileStream(
        deps,
        actor,
        { name: "clip.mp4", mimeType: "video/mp4" },
        streamOf(new TextEncoder().encode("<!doctype html><script>alert(1)</script>")),
      ),
    ).rejects.toBeInstanceOf(DriveValidationError);
    await expect(
      uploadSpaceFileStream(
        deps,
        actor,
        { name: "setup.exe" },
        streamOf(new Uint8Array([0x4d, 0x5a])),
      ),
    ).rejects.toBeInstanceOf(DriveValidationError);
    await expect(
      uploadSpaceFileStream(
        deps,
        actor,
        { name: "payload.bin", mimeType: "application/x-msdownload" },
        streamOf(new Uint8Array([0x4d, 0x5a])),
      ),
    ).rejects.toBeInstanceOf(DriveValidationError);
    // A dot-file name still carries its extension, like Go's filepath.Ext.
    await expect(
      uploadSpaceFileStream(
        deps,
        actor,
        { name: ".hta" },
        streamOf(new TextEncoder().encode("<script>")),
      ),
    ).rejects.toBeInstanceOf(DriveValidationError);
    expect(memory.blobs.size).toBe(0);
    expect(memory.store.putStream).not.toHaveBeenCalled();
  });

  it("skips a BOM before markup but not a lone BOM byte", async () => {
    const fake = fakeDrive();
    const { deps } = depsFor(fake);
    const bomMarkup = new TextEncoder().encode("\ufeff<!doctype html><script>x</script>");
    await expect(
      uploadSpaceFileStream(
        deps,
        actor,
        { name: "bom.mp4", mimeType: "video/mp4" },
        streamOf(bomMarkup),
      ),
    ).rejects.toThrow("active HTML or SVG markup");

    const loneByte = new Uint8Array([0xef, ...new TextEncoder().encode("<html>")]);
    await expect(
      uploadSpaceFileStream(
        deps,
        actor,
        { name: "plain.mp4", mimeType: "video/mp4" },
        streamOf(loneByte),
      ),
    ).resolves.toMatchObject({ name: "plain.mp4", mimeType: "video/mp4" });
  });

  it("enforces the streaming upload cap", async () => {
    const fake = fakeDrive();
    const { deps, memory } = depsFor(fake, 1024 * 1024);
    await expect(
      uploadSpaceFileStream(
        deps,
        actor,
        { name: "big.txt", mimeType: "text/plain" },
        streamOf(new Uint8Array(1024 * 1024 + 1)),
      ),
    ).rejects.toBeInstanceOf(DriveFileTooLargeError);
    expect(memory.blobs.size).toBe(0);
  });

  it("removes its blob when the row insert fails", async () => {
    const fake = fakeDrive({ failCreate: true });
    const { deps, memory } = depsFor(fake);
    await expect(
      uploadSpaceFileStream(
        deps,
        actor,
        { name: "orphan.txt", mimeType: "text/plain" },
        streamOf(new TextEncoder().encode("bytes")),
      ),
    ).rejects.toMatchObject({ kind: "CONFLICT" });
    expect(memory.blobs.size).toBe(0);
    expect(memory.removed).toHaveLength(1);
  });
});

describe("file content", () => {
  it("refuses trashed files and reports a missing blob as not found", async () => {
    const fake = fakeDrive({
      artifacts: [artifactRow({ id: "trashed", trashedAt: new Date() })],
    });
    const { deps } = depsFor(fake);
    await expect(statSpaceFileContent(deps, actor, "trashed")).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
    await expect(statSpaceFileContent(deps, actor, "absent")).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
    const present = fakeDrive({ artifacts: [artifactRow({ id: "present" })] });
    const presentDeps = depsFor(present).deps;
    present.artifacts[0]!.storageKey = "missing-blob";
    await expect(openSpaceFileContent(presentDeps, actor, "present", null)).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
  });

  it("slices a byte range from the decrypted stream", async () => {
    const bytes = new TextEncoder().encode("0123456789");
    const fake = fakeDrive({
      artifacts: [artifactRow({ id: "file-1", size: bytes.byteLength, hash: "digest" })],
    });
    const { deps, memory } = depsFor(fake);
    memory.blobs.set("blob-file-1", bytes);
    const opened = await openSpaceFileContent(deps, actor, "file-1", {
      start: 2,
      endInclusive: 5,
    });
    expect(opened.totalSize).toBe(10);
    expect(opened.meta.hash).toBe("digest");
    expect(new TextDecoder().decode(await collect(opened.stream))).toBe("2345");
  });
});

function listRow(overrides: Partial<ArtifactRow> & { versionCount?: number } = {}) {
  return { ...artifactRow(overrides), versionCount: overrides.versionCount ?? 1 };
}

function fileChangeRow(overrides: Partial<ArtifactRow> = {}) {
  const row = artifactRow(overrides);
  return {
    kind: "file" as const,
    id: row.id,
    parentId: row.folderId,
    name: row.name,
    trashedAt: row.trashedAt,
    updatedAt: row.updatedAt,
    hash: row.hash,
    size: row.size,
    mimeType: row.mimeType,
    version: row.version,
  };
}

function folderChangeRow(overrides: Partial<FolderRow> = {}) {
  const row = folderRow(overrides);
  return {
    kind: "folder" as const,
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    trashedAt: row.trashedAt,
    updatedAt: row.updatedAt,
    hash: null,
    size: null,
    mimeType: null,
    version: null,
  };
}

function queryText(query: RawQuery | undefined): string {
  return query?.strings.join(" ") ?? "";
}

describe("listDriveFiles", () => {
  it("maps the database's latest-version page and carries the cursor into the next query", async () => {
    const v2 = artifactRow({
      id: "v2",
      folderId: "f-root",
      name: "plan.md",
      mimeType: "text/markdown",
      version: 2,
      rootArtifactId: "v1",
      updatedAt: new Date("2026-11-02T00:00:00.000Z"),
    });
    const other = artifactRow({
      id: "other",
      folderId: "f-root",
      name: "notes.txt",
      updatedAt: new Date("2026-11-01T00:00:00.000Z"),
    });
    const fake = fakeDrive({
      folders: [
        folderRow({ id: "f-root", name: "Root" }),
        folderRow({ id: "f-child", parentId: "f-root", name: "Child" }),
      ],
      listResults: [[listRow({ ...v2, versionCount: 2 }), listRow(other)], [listRow(other)]],
    });
    const { deps } = depsFor(fake);
    const page = await listDriveFiles(deps, actor, { folderId: "f-root", limit: 1 });
    expect(page.breadcrumbs).toEqual([{ id: "f-root", name: "Root" }]);
    expect(page.folders.map((folder) => folder.id)).toEqual(["f-child"]);
    expect(page.files).toHaveLength(1);
    expect(page.files[0]).toMatchObject({ id: "v2", version: 2, versionCount: 2 });
    expect(page.nextCursor).not.toBeNull();

    const firstQuery = fake.rawQueries[0]!;
    expect(queryText(firstQuery)).toContain("DISTINCT ON");
    expect(queryText(firstQuery)).toContain("LIMIT");
    expect(firstQuery.values).toContain("space-1");
    expect(firstQuery.values).toContain("f-root");
    expect(firstQuery.values).toContain(2);

    const second = await listDriveFiles(deps, actor, {
      folderId: "f-root",
      limit: 1,
      cursor: page.nextCursor!,
    });
    expect(second.files.map((file) => file.id)).toEqual(["other"]);
    // A cursor page shows no folders, like Go.
    expect(second.folders).toEqual([]);
    const secondQuery = fake.rawQueries[1]!;
    expect(secondQuery.values).toContain(v2.id);
    expect(secondQuery.values).toContainEqual(new Date("2026-11-02T00:00:00.000Z"));
  });

  it("builds the filters, sort and escaped search in SQL", async () => {
    const fake = fakeDrive({
      folders: [folderRow({ id: "f-root", name: "Root" })],
      listResults: [[]],
    });
    const { deps } = depsFor(fake);
    await listDriveFiles(deps, actor, {
      folderId: "f-root",
      category: "video",
      query: "50%_off",
      sortBy: "name",
      sortDir: "asc",
    });
    const query = fake.rawQueries[0]!;
    const text = queryText(query);
    expect(text).toContain("DISTINCT ON");
    expect(text).toContain("LOWER(l.name) ASC");
    expect(text).toContain("ILIKE");
    expect(text).toContain("ESCAPE");
    expect(text).toContain("LIKE 'video/%'");
    expect(text).toContain("LIMIT");
    expect(query.values).toContain("%50\\%\\_off%");
    expect(query.values).toContain(51);
    expect(query.values).not.toContain("50%_off");
  });

  it("lists trashed families from the Trash view and hides folders from cursor pages", async () => {
    const gone = artifactRow({
      id: "gone",
      name: "gone.txt",
      trashedAt: new Date("2026-11-03T00:00:00.000Z"),
    });
    const fake = fakeDrive({
      folders: [folderRow({ id: "f-trash", trashedAt: new Date() })],
      listResults: [[listRow(gone)]],
    });
    const { deps } = depsFor(fake);
    const trash = await listDriveFiles(deps, actor, { trashed: true });
    expect(trash.files.map((file) => file.id)).toEqual(["gone"]);
    expect(trash.files[0]!.trashedAt).toBe("2026-11-03T00:00:00.000Z");
    expect(trash.folders.map((folder) => folder.id)).toEqual(["f-trash"]);
    const text = queryText(fake.rawQueries[0]);
    expect(text).toContain('"trashedAt" IS NOT NULL');
    expect(text).not.toContain('l."folderId" IS NULL');
    expect(text).not.toContain('l."folderId" =');
  });

  it("rejects malformed cursors and invalid sort or category choices", async () => {
    const fake = fakeDrive({ listResults: [[]] });
    const { deps } = depsFor(fake);
    await expect(listDriveFiles(deps, actor, { cursor: "not*base64" })).rejects.toMatchObject({
      kind: "BAD_REQUEST",
    });
    const timestampCursor = Buffer.from(
      JSON.stringify({ k: "not-a-date", i: "v1" }),
      "utf8",
    ).toString("base64url");
    await expect(listDriveFiles(deps, actor, { cursor: timestampCursor })).rejects.toThrow(
      "Invalid cursor timestamp",
    );
    await expect(listDriveFiles(deps, actor, { sortBy: "createdAt" as never })).rejects.toThrow(
      "Invalid sortBy",
    );
    await expect(listDriveFiles(deps, actor, { category: "other" as never })).rejects.toThrow(
      "Invalid file category",
    );
  });
});

describe("listDriveChanges", () => {
  it("pages a combined folder/file feed with the cursor in SQL", async () => {
    const folder = folderRow({
      id: "f-1",
      name: "One",
      updatedAt: new Date("2026-11-01T00:00:00.000Z"),
    });
    const file = artifactRow({
      id: "a-2",
      name: "a.txt",
      version: 2,
      rootArtifactId: "a-1",
      updatedAt: new Date("2026-11-03T00:00:00.000Z"),
    });
    const fake = fakeDrive({
      changeResults: [[folderChangeRow(folder), fileChangeRow(file)], [fileChangeRow(file)]],
    });
    const { deps } = depsFor(fake);
    const first = await listDriveChanges(deps, actor, { limit: 1 });
    expect(first.items.map((item) => item.id)).toEqual(["f-1"]);
    expect(first.hasMore).toBe(true);
    expect(first.items[0]).toMatchObject({ kind: "folder", hash: null, version: null });
    const firstQuery = fake.rawQueries[0]!;
    const text = queryText(firstQuery);
    expect(text).toContain("WITH combined");
    expect(text).toContain("UNION ALL");
    expect(text).toContain("DISTINCT ON");
    expect(text).toContain('ORDER BY u."updatedAt" ASC, u.id ASC');
    expect(text).toContain("LIMIT");
    expect(firstQuery.values).toContain("space-1");
    expect(firstQuery.values).toContain(2);

    const second = await listDriveChanges(deps, actor, {
      limit: 5,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.id)).toEqual(["a-2"]);
    expect(second.items[0]).toMatchObject({ kind: "file", version: 2, hash: file.hash });
    expect(second.hasMore).toBe(false);
    const secondQuery = fake.rawQueries[1]!;
    expect(secondQuery.values).toContainEqual(new Date("2026-11-01T00:00:00.000Z"));
    expect(secondQuery.values).toContain("f-1");
  });
});

describe("folder operations", () => {
  it("refuses to nest past the depth limit and to move a folder into its descendant", async () => {
    const chain: FolderRow[] = [];
    let parentId: string | null = null;
    for (let depth = 1; depth <= 20; depth++) {
      const id = `deep-${depth}`;
      chain.push(folderRow({ id, parentId, name: `depth ${depth}` }));
      parentId = id;
    }
    const fake = fakeDrive({ folders: chain });
    const { deps } = depsFor(fake);
    await expect(
      createDriveFolder(deps, actor, { parentId: "deep-20", name: "too deep" }),
    ).rejects.toThrow("Folder nesting limit reached");

    const cycle = fakeDrive({
      folders: [
        folderRow({ id: "outer", name: "Outer" }),
        folderRow({ id: "inner", parentId: "outer", name: "Inner" }),
      ],
    });
    await expect(
      moveDriveFolder(depsFor(cycle).deps, actor, { folderId: "outer", parentId: "inner" }),
    ).rejects.toThrow("Cannot move a folder into one of its descendants");
  });

  it("rejects a duplicate folder name where the unique index would", async () => {
    const fake = fakeDrive({ folders: [folderRow({ id: "one", name: "Reports" })] });
    const { deps } = depsFor(fake);
    await expect(createDriveFolder(deps, actor, { name: "reports" })).rejects.toMatchObject({
      kind: "CONFLICT",
    });
    await expect(
      renameDriveFolder(deps, actor, { folderId: "one", name: "Reports" }),
    ).resolves.toMatchObject({ id: "one", name: "Reports" });
  });

  it("trashes descendants, restores them, and deletes rows and blobs permanently", async () => {
    const fake = fakeDrive({
      folders: [
        folderRow({ id: "parent", name: "Parent" }),
        folderRow({ id: "child", parentId: "parent", name: "Child" }),
      ],
      artifacts: [
        artifactRow({
          id: "in-parent",
          folderId: "parent",
          storageKey: "blob-in-parent",
          name: "a.txt",
        }),
        artifactRow({
          id: "in-child",
          folderId: "child",
          storageKey: "blob-in-child",
          name: "b.txt",
        }),
        artifactRow({ id: "outside", storageKey: "blob-outside", name: "c.txt" }),
      ],
    });
    const { deps, memory } = depsFor(fake);
    await trashDriveFolder(deps, actor, "parent");
    expect(fake.folders.every((folder) => folder.trashedAt !== null)).toBe(true);
    expect(fake.artifacts.find((row) => row.id === "in-child")?.trashedAt).not.toBeNull();
    expect(fake.artifacts.find((row) => row.id === "outside")?.trashedAt).toBeNull();

    const restored = await restoreDriveFolder(deps, actor, "parent");
    expect(restored.trashedAt).toBeNull();
    expect(fake.artifacts.find((row) => row.id === "in-child")?.trashedAt).toBeNull();

    await deleteDriveFolderPermanent(deps, actor, "parent");
    expect(fake.folders.map((folder) => folder.id)).toEqual([]);
    expect(fake.artifacts.map((row) => row.id)).toEqual(["outside"]);
    expect(memory.removed.sort()).toEqual(["blob-in-child", "blob-in-parent"]);
  });
});

describe("file operations", () => {
  it("restores a file to the root when its folder is trashed", async () => {
    const fake = fakeDrive({
      folders: [folderRow({ id: "trashed-folder", trashedAt: new Date() })],
      artifacts: [
        artifactRow({
          id: "v1",
          folderId: "trashed-folder",
          name: "doc.txt",
          trashedAt: new Date(),
        }),
        artifactRow({
          id: "v2",
          folderId: "trashed-folder",
          name: "doc.txt",
          version: 2,
          rootArtifactId: "v1",
          trashedAt: new Date(),
        }),
      ],
    });
    const { deps } = depsFor(fake);
    const restored = await restoreDriveFile(deps, actor, "v2");
    expect(restored).toMatchObject({ folderId: null, trashedAt: null, versionCount: 2 });
    expect(fake.artifacts.every((row) => row.folderId === null && row.trashedAt === null)).toBe(
      true,
    );
  });

  it("deletes every version's blob and row", async () => {
    const fake = fakeDrive({
      artifacts: [
        artifactRow({ id: "root", name: "a.txt", storageKey: "blob-root" }),
        artifactRow({
          id: "child",
          name: "a.txt",
          version: 2,
          rootArtifactId: "root",
          storageKey: "blob-child",
        }),
      ],
    });
    const { deps, memory } = depsFor(fake);
    await deleteDriveFilePermanent(deps, actor, "child");
    expect(fake.artifacts).toEqual([]);
    expect(memory.removed.sort()).toEqual(["blob-child", "blob-root"]);
    await expect(getDriveFile(deps, actor, "root")).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it("trashes a whole family and empties Trash with its blobs", async () => {
    const fake = fakeDrive({
      folders: [folderRow({ id: "trash-folder", trashedAt: new Date(), name: "Old" })],
      artifacts: [
        artifactRow({ id: "a", name: "a.txt", storageKey: "blob-a" }),
        artifactRow({ id: "b", name: "b.txt", storageKey: "blob-b" }),
      ],
    });
    const { deps, memory } = depsFor(fake);
    await trashDriveFile(deps, actor, "a");
    expect(fake.artifacts.find((row) => row.id === "a")?.trashedAt).not.toBeNull();
    expect(fake.artifacts.find((row) => row.id === "b")?.trashedAt).toBeNull();
    const deleted = await emptyDriveTrash(deps, actor);
    expect(deleted).toBe(1);
    expect(fake.artifacts.map((row) => row.id)).toEqual(["b"]);
    expect(fake.folders).toEqual([]);
    expect(memory.removed).toEqual(["blob-a"]);
  });

  it("updates file name, slug, and description across every version in a family", async () => {
    const fake = fakeDrive({
      artifacts: [
        artifactRow({ id: "root", name: "draft.md", slug: "draft" }),
        artifactRow({
          id: "v2",
          name: "draft.md",
          slug: "draft",
          version: 2,
          rootArtifactId: "root",
        }),
      ],
    });
    const { deps } = depsFor(fake);
    const updated = await updateDriveFile(deps, actor, {
      fileId: "v2",
      name: "final-spec.md",
      slug: "Final Spec v2",
      description: "Finalized architecture specification",
    });
    expect(updated).toMatchObject({
      id: "v2",
      name: "final-spec.md",
      slug: "final-spec-v2",
      description: "Finalized architecture specification",
      versionCount: 2,
    });
    expect(
      fake.artifacts.every((row) => row.slug === "final-spec-v2" && row.name === "final-spec.md"),
    ).toBe(true);
  });

  it("auto-organizes bot-created uploads into a bot-linked folder with a default slug", async () => {
    const fake = fakeDrive({ bots: ["bot-1"], botName: "Research Bot" });
    const { deps } = depsFor(fake);

    const created = await uploadSpaceFileStream(
      deps,
      actor,
      {
        botId: "bot-1",
        source: "bot",
        name: "Q4 Market Report.txt",
        mimeType: "text/plain",
      },
      new Blob(["market summary"]).stream(),
    );
    expect(created.slug).toBe("q4-market-report");
    expect(created.folderId).toBeTruthy();
    expect(fake.folders[0]).toMatchObject({
      id: created.folderId,
      botId: "bot-1",
      name: "Research Bot",
    });
  });
});

describe("content helpers", () => {
  it("parses single byte ranges like the Go handler", () => {
    expect(parseSingleByteRange("", 10)).toEqual({ range: null, unsatisfiable: false });
    expect(parseSingleByteRange("bytes=2-5", 10)).toEqual({
      range: { start: 2, endInclusive: 5 },
      unsatisfiable: false,
    });
    expect(parseSingleByteRange("bytes=5-", 10)).toEqual({
      range: { start: 5, endInclusive: 9 },
      unsatisfiable: false,
    });
    expect(parseSingleByteRange("bytes=-3", 10)).toEqual({
      range: { start: 7, endInclusive: 9 },
      unsatisfiable: false,
    });
    expect(parseSingleByteRange("bytes=999-1000", 10)).toEqual({
      range: null,
      unsatisfiable: true,
    });
    expect(parseSingleByteRange("bytes=0-1,4-5", 10)).toEqual({
      range: null,
      unsatisfiable: false,
    });
    expect(parseSingleByteRange("bytes=3-2", 10)).toEqual({
      range: null,
      unsatisfiable: true,
    });
    expect(parseSingleByteRange("bytes=-2", 0)).toEqual({ range: null, unsatisfiable: true });
  });

  it("answers an over-limit upload with 413 and other refusals by kind", () => {
    expect(fileErrorStatus(new DriveFileTooLargeError(1024))).toBe(413);
    expect(fileErrorStatus(new DriveValidationError("bad name"))).toBe(400);
    expect(fileErrorStatus(new DriveNotFoundError("missing"))).toBe(404);
  });

  it("matches weak ETags and never inlines active markup", () => {
    expect(matchesIfNoneMatch('W/"abc"', '"abc"')).toBe(true);
    expect(matchesIfNoneMatch('"other", "abc"', '"abc"')).toBe(true);
    expect(matchesIfNoneMatch("*", '"abc"')).toBe(true);
    expect(matchesIfNoneMatch('"other"', '"abc"')).toBe(false);
    expect(isSafeInlineMedia("video/mp4")).toBe(true);
    expect(isSafeInlineMedia("image/png")).toBe(true);
    expect(isSafeInlineMedia("text/plain")).toBe(true);
    expect(isSafeInlineMedia("text/html")).toBe(false);
    expect(isSafeInlineMedia("image/svg+xml")).toBe(false);
    expect(isSafeInlineMedia("application/x-sh")).toBe(false);
    expect(formatContentDisposition(false, 'a"b\nc.txt')).toBe('attachment; filename="a_b_c.txt"');
    expect(formatContentDisposition(true, "résumé.pdf")).toBe(
      "inline; filename=\"r_sum_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
    );
  });

  it("streams multipart metadata before the file part, splitting on chunk boundaries", async () => {
    const boundary = "rakazo-boundary";
    const fileBytes = new TextEncoder().encode("file-content");
    const body = new Uint8Array(
      Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nstreamed.txt\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="mimeType"\r\n\r\ntext/plain\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="streamed.txt"\r\n` +
            `Content-Type: text/plain\r\n\r\n`,
        ),
        Buffer.from(fileBytes),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Tiny chunks force the parser to split header and boundary tokens.
        for (let offset = 0; offset < body.byteLength; offset += 3) {
          controller.enqueue(body.subarray(offset, offset + 3));
        }
        controller.close();
      },
    });
    const fields: string[] = [];
    let uploaded: Uint8Array | null = null;
    for await (const part of openMultipartParts(stream, boundary)) {
      if (part.kind === "field") fields.push(`${part.name}=${part.value}`);
      else uploaded = await collect(part.stream);
    }
    expect(fields).toEqual(["name=streamed.txt", "mimeType=text/plain"]);
    expect(new TextDecoder().decode(uploaded!)).toBe("file-content");
  });
});
