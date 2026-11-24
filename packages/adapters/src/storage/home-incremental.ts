import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { copyFile, mkdir, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { WorkspaceExportLimits } from "@rakazo/adapter-kit";
import { WorkspaceTooLargeError } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import type { HomeArchiveLimits } from "./home-archive.js";
import {
  ByteReader,
  countEntry,
  HomeArchiveError,
  isArchivePath,
  openContained,
  saveBounds,
  walkHome,
} from "./home-archive.js";
import { shouldSkipPortableWorkspaceFile, WORKSPACE_SAVE_LIMITS } from "./workspace-save-policy.js";

/**
 * A home revision that stores only what changed. Saving the whole home every time costs as much
 * as the home is big, however little a bot touched; here a save reads and uploads the files that
 * changed since the stored revision and points at the rest.
 *
 *   magic "RKZI\x01"
 *   header length u32 | header JSON {startedAtMs, dataBytes, refs: [{revision, dataBytes}]}
 *   table length u32  | gzip of one JSON array per line:
 *                       [kind 0 dir | 1 file, path, mode, size, changedMs, sha256, source, offset]
 *   data: the bytes of the files this revision adds, back to back
 *
 * `source` is -1 when a file's bytes are in this revision's own data, else an index into `refs`,
 * the earlier revisions whose data this one reads. `offset` is where the bytes start in that
 * revision's data. Files with the same contents are stored once. Every revision lists the whole
 * home, so one is readable with only the revisions it names, and a revision stays in the bucket
 * for as long as a kept revision names it.
 */

const MAGIC = Buffer.from("RKZI\x01", "latin1");
const READ_CHUNK = 1024 * 1024;
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_TABLE_BYTES = 1024 ** 3;
const MAX_HEADER_REFS = 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EMPTY_HASH = createHash("sha256").digest("hex");
/**
 * A file changed this close before a save began may change again within the clock's resolution
 * without its change time moving, so it is read again next time rather than trusted.
 */
const RACY_MS = 2000;
/** More earlier revisions than this are read from, and the next save writes everything afresh. */
const MAX_REFS = 32;
/** Bytes held by earlier revisions beyond twice the live files, plus this, trigger a fresh save. */
const COMPACT_SLACK_BYTES = 256 * 1024 ** 2;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export class NotIncrementalRevisionError extends HomeArchiveError {
  constructor() {
    super("Not an incremental home revision");
    this.name = "NotIncrementalRevisionError";
  }
}

interface ManifestEntry {
  kind: "directory" | "file";
  path: string;
  mode: number;
  size: number;
  changedMs: number;
  /** SHA-256 of the contents, hex; empty for a directory. */
  hash: string;
  source: number;
  offset: number;
}

interface Header {
  /** When the save that wrote this began; files changed just before it are not trusted. */
  startedAtMs: number;
  /** Bytes of the files this revision adds. */
  dataBytes: number;
  refs: Array<{ revision: string; dataBytes: number }>;
}

export interface Manifest extends Header {
  entries: ManifestEntry[];
}

/** The stored revision a save builds on. */
export interface PreviousRevision {
  revision: string;
  manifest: Manifest;
}

/** Where some bytes are: in the revision being written (undefined), or in an earlier one. */
interface Location {
  revision: string | undefined;
  offset: number;
}

export interface PreparedRevision {
  /** The earlier revisions this one reads, which must outlive it. */
  references: string[];
  stats: { files: number; reused: number; ownBytes: number; liveBytes: number };
  /** The plaintext revision, ready to seal and upload. Reads only the staged files. */
  stream(): AsyncGenerator<Buffer>;
  /** Removes the staged files. */
  dispose(): Promise<void>;
}

function u32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reads what a save needs to know of the stored revision, or undefined for a revision stored as
 * a whole archive. Stops reading once the table is in hand.
 */
export async function readManifest(
  source: AsyncIterable<Uint8Array>,
  limits: HomeArchiveLimits,
): Promise<Manifest | undefined> {
  const reader = new ByteReader(source);
  try {
    return await readPreamble(reader, limits, true);
  } catch (error) {
    if (error instanceof NotIncrementalRevisionError) return undefined;
    throw error;
  } finally {
    await reader.close();
  }
}

/** Whether a revision's bytes begin as an incremental revision; the bytes are returned whole. */
export async function peekIncremental(
  source: AsyncIterable<Uint8Array>,
): Promise<{ incremental: boolean; body: AsyncIterable<Uint8Array> }> {
  const iterator = source[Symbol.asyncIterator]();
  const held: Buffer[] = [];
  let length = 0;
  let done = false;
  while (length < MAGIC.length && !done) {
    const next = await iterator.next();
    if (next.done) done = true;
    else {
      held.push(Buffer.from(next.value));
      length += next.value.length;
    }
  }
  const head = Buffer.concat(held);
  async function* body() {
    try {
      if (head.length) yield head;
      while (!done) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await iterator.return?.(undefined);
    }
  }
  return { incremental: head.subarray(0, MAGIC.length).equals(MAGIC), body: body() };
}

async function readPreamble(
  reader: ByteReader,
  limits: HomeArchiveLimits,
  withTable: true,
): Promise<Manifest>;
async function readPreamble(
  reader: ByteReader,
  limits: HomeArchiveLimits,
  withTable: false,
): Promise<Header>;
async function readPreamble(
  reader: ByteReader,
  limits: HomeArchiveLimits,
  withTable: boolean,
): Promise<Header | Manifest> {
  const magic = await reader.read(MAGIC.length).catch(() => undefined);
  if (!magic?.equals(MAGIC)) throw new NotIncrementalRevisionError();
  const headerLength = (await reader.read(4)).readUInt32BE(0);
  if (headerLength > MAX_HEADER_BYTES) throw new HomeArchiveError("Home revision header is huge");
  const header = parseHeader((await reader.read(headerLength)).toString("utf8"));
  const tableLength = (await reader.read(4)).readUInt32BE(0);
  if (!withTable) {
    await reader.skip(tableLength);
    return header;
  }
  if (tableLength > MAX_TABLE_BYTES) throw new HomeArchiveError("Home revision table is huge");
  const table = await gunzipAsync(await reader.read(tableLength), {
    maxOutputLength: MAX_TABLE_BYTES,
  }).catch(() => {
    throw new HomeArchiveError("Home revision table is corrupt");
  });
  return { ...header, entries: parseTable(table.toString("utf8"), header, limits) };
}

function parseHeader(text: string): Header {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HomeArchiveError("Home revision header is corrupt");
  }
  const header = parsed as Partial<Header> | null;
  if (
    !header ||
    !isCount(header.startedAtMs) ||
    !isCount(header.dataBytes) ||
    !Array.isArray(header.refs) ||
    header.refs.length > MAX_HEADER_REFS ||
    !header.refs.every(
      (ref) =>
        typeof ref?.revision === "string" &&
        REVISION_PATTERN.test(ref.revision) &&
        isCount(ref.dataBytes),
    )
  )
    throw new HomeArchiveError("Home revision header is corrupt");
  return { startedAtMs: header.startedAtMs, dataBytes: header.dataBytes, refs: header.refs };
}

function parseTable(text: string, header: Header, limits: HomeArchiveLimits): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const seen = new Set<string>();
  const counts = { bytes: 0, entries: 0 };
  for (const line of text.split("\n")) {
    if (!line) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      throw new HomeArchiveError("Home revision table is corrupt");
    }
    if (!Array.isArray(row) || row.length !== 8) throw corrupt();
    const [kind, relative, mode, size, changedMs, hash, source, offset] = row as unknown[];
    if (
      (kind !== 0 && kind !== 1) ||
      typeof relative !== "string" ||
      !isArchivePath(relative) ||
      !isCount(mode) ||
      mode > 0o777 ||
      !isCount(size) ||
      !isCount(changedMs) ||
      typeof hash !== "string" ||
      typeof source !== "number" ||
      !Number.isSafeInteger(source) ||
      source < -1 ||
      source >= header.refs.length ||
      !isCount(offset)
    )
      throw corrupt();
    if (seen.has(relative)) throw new HomeArchiveError("Home revision repeats an entry");
    seen.add(relative);
    if (kind === 0) {
      if (hash !== "" || size !== 0 || source !== -1 || offset !== 0) throw corrupt();
      countEntry(counts, 0, limits);
      entries.push({
        kind: "directory",
        path: relative,
        mode,
        size: 0,
        changedMs,
        hash: "",
        source: -1,
        offset: 0,
      });
      continue;
    }
    const held = source === -1 ? header.dataBytes : refAt(header, source).dataBytes;
    if (!HASH_PATTERN.test(hash) || offset + size > held) throw corrupt();
    countEntry(counts, size, limits);
    entries.push({ kind: "file", path: relative, mode, size, changedMs, hash, source, offset });
  }
  return entries;
}

function corrupt() {
  return new HomeArchiveError("Home revision table is corrupt");
}

/** The earlier revision a table row names; the table is checked against the header on read. */
function refAt(header: Header, index: number) {
  const ref = header.refs[index];
  if (!ref) throw corrupt();
  return ref;
}

function locationOf(previous: PreviousRevision, entry: ManifestEntry): Location {
  const { manifest } = previous;
  return {
    revision: entry.source === -1 ? previous.revision : refAt(manifest, entry.source).revision,
    offset: entry.offset,
  };
}

/** Earlier revisions hold too much dead data, or too many are read: start over with one. */
function needsFreshSave(previous: PreviousRevision) {
  const { manifest } = previous;
  if (manifest.refs.length >= MAX_REFS) return true;
  const held = manifest.refs.reduce((sum, ref) => sum + ref.dataBytes, manifest.dataBytes);
  const live = new Map<string, number>();
  for (const entry of manifest.entries)
    if (entry.kind === "file") live.set(`${entry.source}:${entry.offset}`, entry.size);
  const liveBytes = [...live.values()].reduce((sum, size) => sum + size, 0);
  return held > 2 * liveBytes + COMPACT_SLACK_BYTES;
}

/**
 * Walks the home and stages what changed since `previous`. A file whose change time and size
 * match the stored entry (and was not changed just before that save began) is not read; any other
 * is hashed, and stored only if no stored file has the same contents. The staged bytes are a
 * snapshot, so a file changing while it is read cannot make a stored hash disagree with its
 * bytes. The caller streams the result, then disposes it.
 */
export async function prepareRevision(input: {
  root: string;
  previous?: PreviousRevision;
  limits: HomeArchiveLimits;
  saveLimits?: WorkspaceExportLimits;
  /** A directory on a volume with room for the changed files. */
  scratch: string;
}): Promise<PreparedRevision> {
  const saveLimits = input.saveLimits ?? WORKSPACE_SAVE_LIMITS;
  const limits = saveBounds(input.limits, saveLimits);
  const root = await realpath(input.root);
  const startedAtMs = Date.now();
  const previous = input.previous && !needsFreshSave(input.previous) ? input.previous : undefined;

  const before = new Map<string, { entry: ManifestEntry; location: Location }>();
  const known = new Map<string, Location>();
  const pinned = new Map<string, number>();
  if (previous) {
    pinned.set(previous.revision, previous.manifest.dataBytes);
    for (const ref of previous.manifest.refs) pinned.set(ref.revision, ref.dataBytes);
    for (const entry of previous.manifest.entries) {
      if (entry.kind !== "file") continue;
      const location = locationOf(previous, entry);
      before.set(entry.path, { entry, location });
      known.set(entry.hash, location);
    }
  }

  const packPath = path.join(input.scratch, `pack-${randomBytes(8).toString("hex")}`);
  const pack = await open(packPath, "wx", 0o600);
  let packEnd = 0;
  const entries: ManifestEntry[] = [];
  const locations: Array<Location | undefined> = [];
  const counts = { bytes: 0, entries: 0, files: 0, oversized: 0 };
  let reused = 0;

  /** Hashes a file while copying it into the staged data at `at`. */
  const store = (handle: FileHandle, size: number, at: number) =>
    readFile(handle, size, async (chunk, position) => {
      for (let done = 0; done < chunk.length; ) {
        const { bytesWritten } = await pack.write(
          chunk,
          done,
          chunk.length - done,
          at + position + done,
        );
        done += bytesWritten;
      }
    });

  try {
    for await (const walked of walkHome(
      root,
      root,
      "",
      new Set([root]),
      limits.maxFileBytes,
      counts,
    )) {
      if (walked.kind === "directory") {
        countEntry(counts, 0, limits);
        entries.push({
          kind: "directory",
          path: walked.relative,
          mode: walked.mode,
          size: 0,
          changedMs: 0,
          hash: "",
          source: -1,
          offset: 0,
        });
        locations.push(undefined);
        continue;
      }
      if (++counts.files > saveLimits.maxFiles) throw new WorkspaceTooLargeError("files");
      const changedMs = Math.floor(walked.changedMs);
      const earlier = before.get(walked.relative);
      if (
        previous &&
        earlier &&
        earlier.entry.size === walked.size &&
        earlier.entry.changedMs === changedMs &&
        changedMs < previous.manifest.startedAtMs - RACY_MS
      ) {
        countEntry(counts, walked.size, limits);
        entries.push({ ...earlier.entry, mode: walked.mode });
        locations.push(earlier.location);
        reused += 1;
        continue;
      }
      const handle = await openContained(root, walked.resolved);
      if (!handle) continue;
      try {
        const { size } = await handle.stat();
        countEntry(counts, size, limits);
        // Contents that are probably as stored are hashed first and staged only if they differ;
        // anything else is staged as it is hashed, and dropped again if the contents are known.
        let read: { hash: string; bytes: number };
        let location: Location | undefined;
        if (earlier && earlier.entry.size === size) {
          read = await readFile(handle, size);
          location = known.get(read.hash);
          if (!location) read = await store(handle, size, packEnd);
        } else {
          read = await store(handle, size, packEnd);
          location = known.get(read.hash);
          if (location) await pack.truncate(packEnd);
        }
        if (!location) {
          location = { revision: undefined, offset: packEnd };
          packEnd += read.bytes;
          known.set(read.hash, location);
        }
        entries.push({
          kind: "file",
          path: walked.relative,
          mode: walked.mode,
          size: read.bytes,
          changedMs,
          hash: read.hash,
          source: -1,
          offset: 0,
        });
        locations.push(location);
      } finally {
        await handle.close();
      }
    }
    await pack.close();
  } catch (error) {
    await pack.close().catch(() => undefined);
    await rm(packPath, { force: true });
    throw error;
  }

  if (counts.oversized)
    getLogger().warn("home.save_skipped_large_files", {
      files: counts.oversized,
      max_file_bytes: limits.maxFileBytes,
    });

  const refIndex = new Map<string, number>();
  const refs: Header["refs"] = [];
  entries.forEach((entry, index) => {
    const location = locations[index];
    if (!location) return;
    entry.offset = location.offset;
    if (location.revision === undefined) return;
    let source = refIndex.get(location.revision);
    if (source === undefined) {
      source = refs.length;
      refIndex.set(location.revision, source);
      refs.push({ revision: location.revision, dataBytes: pinned.get(location.revision) ?? 0 });
    }
    entry.source = source;
  });

  const header = Buffer.from(JSON.stringify({ startedAtMs, dataBytes: packEnd, refs }));
  const table = await gzipAsync(
    Buffer.from(
      entries
        .map(
          (entry) =>
            `${JSON.stringify([
              entry.kind === "directory" ? 0 : 1,
              entry.path,
              entry.mode,
              entry.size,
              entry.changedMs,
              entry.hash,
              entry.source,
              entry.offset,
            ])}\n`,
        )
        .join(""),
    ),
  );

  return {
    references: refs.map((ref) => ref.revision),
    stats: {
      files: counts.files,
      reused,
      ownBytes: packEnd,
      liveBytes: counts.bytes,
    },
    async *stream() {
      yield Buffer.concat([MAGIC, u32(header.length), header, u32(table.length), table]);
      yield* createReadStream(packPath, { highWaterMark: READ_CHUNK });
    },
    dispose: () => rm(packPath, { force: true }),
  };
}

/** Hashes a file's bytes, handing each chunk and its position to `sink` first. */
async function readFile(
  handle: FileHandle,
  size: number,
  sink?: (chunk: Buffer, position: number) => Promise<void>,
): Promise<{ hash: string; bytes: number }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK, Math.max(size, 1)));
  let position = 0;
  while (position < size) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, size - position),
      position,
    );
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    await sink?.(chunk, position);
    position += bytesRead;
  }
  return { hash: hash.digest("hex"), bytes: position };
}

/**
 * Writes a stored home into `dest` (an empty directory the caller just created), or only checks
 * it when there is none. Files never replace anything and nothing is written through a link.
 * Every file is checked against its stored hash, so bytes read from the wrong place fail here.
 * `open` returns another revision's plaintext, for the files this one points at.
 */
export async function restoreHome(
  primary: AsyncIterable<Uint8Array>,
  open: (revision: string) => AsyncIterable<Uint8Array>,
  dest: string | undefined,
  limits: HomeArchiveLimits,
): Promise<{ entries: number; bytes: number }> {
  const reader = new ByteReader(primary);
  try {
    const manifest = await readPreamble(reader, limits, true);
    const wanted = manifest.entries.filter((entry) => {
      if (entry.kind === "directory") return false;
      return !shouldSkipPortableWorkspaceFile(entry.path);
    });
    if (dest) {
      for (const entry of manifest.entries) {
        if (entry.kind !== "directory" || shouldSkipPortableWorkspaceFile(entry.path, true))
          continue;
        await mkdir(path.join(dest, entry.path), { recursive: true, mode: 0o700 });
      }
    }
    const groups = new Map<number, ManifestEntry[]>();
    for (const entry of wanted)
      groups.set(entry.source, [...(groups.get(entry.source) ?? []), entry]);
    // The primary stream is read once, front to back, so its own files come first.
    await extract(reader, groups.get(-1) ?? [], manifest.dataBytes, dest, true);
    if (!(await reader.atEnd())) throw new HomeArchiveError("Home revision has trailing data");
    for (const [source, files] of groups) {
      if (source === -1) continue;
      const ref = refAt(manifest, source);
      const other = new ByteReader(open(ref.revision));
      try {
        const header = await readPreamble(other, limits, false);
        if (header.dataBytes !== ref.dataBytes)
          throw new HomeArchiveError("Home revision does not match the revision that names it");
        await extract(other, files, ref.dataBytes, dest, false);
      } finally {
        await other.close();
      }
    }
    return {
      entries: manifest.entries.length,
      bytes: manifest.entries.reduce((sum, entry) => sum + entry.size, 0),
    };
  } finally {
    await reader.close();
  }
}

/** Writes the files whose bytes sit at `offset` in a revision's data, which `reader` starts at. */
async function extract(
  reader: ByteReader,
  files: ManifestEntry[],
  dataBytes: number,
  dest: string | undefined,
  drain: boolean,
) {
  const ordered = files.filter((file) => file.size > 0).sort((a, b) => a.offset - b.offset);
  const written = new Map<number, { path: string; hash: string; size: number }>();
  let position = 0;
  for (const file of files) {
    if (file.size === 0) {
      if (file.hash !== EMPTY_HASH) throw corrupt();
      if (dest) await writeFileFrom(dest, file, (async function* () {})());
    }
  }
  for (const file of ordered) {
    const first = written.get(file.offset);
    if (first) {
      if (first.hash !== file.hash || first.size !== file.size) throw corrupt();
      if (dest) await copyInto(dest, first.path, file);
      continue;
    }
    if (file.offset < position) throw corrupt();
    await reader.skip(file.offset - position);
    await writeFileFrom(dest, file, reader.stream(file.size));
    position = file.offset + file.size;
    written.set(file.offset, { path: file.path, hash: file.hash, size: file.size });
  }
  if (drain) await reader.skip(dataBytes - position);
}

async function writeFileFrom(
  dest: string | undefined,
  file: ManifestEntry,
  body: AsyncIterable<Buffer>,
) {
  const hash = createHash("sha256");
  let handle: FileHandle | undefined;
  try {
    if (dest) {
      const target = path.join(dest, file.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      handle = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    }
    for await (const chunk of body) {
      hash.update(chunk);
      if (!handle) continue;
      for (let offset = 0; offset < chunk.length; ) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        offset += bytesWritten;
      }
    }
    if (hash.digest("hex") !== file.hash)
      throw new HomeArchiveError("A stored home file does not match its manifest");
    await handle?.chmod(file.mode | 0o600);
  } finally {
    await handle?.close();
  }
}

async function copyInto(dest: string, from: string, file: ManifestEntry) {
  const target = path.join(dest, file.path);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(path.join(dest, from), target, constants.COPYFILE_EXCL);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    await handle.chmod(file.mode | 0o600);
  } finally {
    await handle.close();
  }
}
