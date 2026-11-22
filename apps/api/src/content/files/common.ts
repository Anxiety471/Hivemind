import path from "node:path";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import type {
  DriveFile,
  FileCategory,
  FileFolder,
  FileSortBy,
  FileSortDir,
  FileSource,
  FolderBreadcrumb,
} from "@rakazo/contracts";
import {
  ATTACHMENT_CODE_MIME_TYPES,
  attachmentSizeLabel,
  normalizeMimeType,
} from "@rakazo/contracts";
import {
  AttachmentValidationError,
  ClientError,
  inferAttachmentMimeType,
  validateDriveName,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/**
 * Shared Space Drive types, validation and row mapping for the TypeScript fallback of
 * apps/api-go/internal/drive/service.go.
 */

export const MAX_FOLDER_DEPTH = 20;
/** Bytes peeked before streaming to reject spoofed images/PDFs and markup polyglots. */
export const SNIFF_BYTES = 1024;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_CHANGE_LIMIT = 100;
export const MAX_CHANGE_LIMIT = 200;

export const FILE_SOURCES: Record<string, true> = {
  upload: true,
  chat: true,
  bot: true,
  email: true,
  messaging: true,
};
export const FILE_CATEGORIES: Record<string, true> = {
  all: true,
  video: true,
  image: true,
  audio: true,
  document: true,
  code: true,
  archive: true,
};

/** Go filepolicy.blockedExtensions. */
const BLOCKED_EXTENSIONS: Record<string, true> = {
  ".exe": true,
  ".dll": true,
  ".msi": true,
  ".msp": true,
  ".mst": true,
  ".scr": true,
  ".com": true,
  ".pif": true,
  ".cpl": true,
  ".hta": true,
  ".sys": true,
  ".drv": true,
  ".ocx": true,
  ".vxd": true,
};
/** Go filepolicy.blockedMIMETypes. */
const BLOCKED_MIME_TYPES: Record<string, true> = {
  "application/x-msdownload": true,
  "application/x-ms-installer": true,
  "application/x-msi": true,
  "application/vnd.microsoft.portable-executable": true,
  "application/x-dosexec": true,
  "application/x-executable": true,
};
const COMPOUND_EXTENSIONS = [".tar.gz", ".tar.bz2", ".tar.xz"];
const MIME_SYNTAX = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
/** Go's code category includes HTML, which the attachment code list leaves to the text branch. */
export const DRIVE_CODE_MIME_TYPES = [...ATTACHMENT_CODE_MIME_TYPES, "text/html"];

export const FILE_SELECT = {
  id: true,
  botId: true,
  groupId: true,
  runId: true,
  folderId: true,
  source: true,
  name: true,
  description: true,
  mimeType: true,
  size: true,
  hash: true,
  version: true,
  trashedAt: true,
  createdAt: true,
  updatedAt: true,
  rootArtifactId: true,
} as const;

export const FOLDER_SELECT = {
  id: true,
  parentId: true,
  name: true,
  trashedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface DriveDeps {
  prisma: PrismaClient;
  artifacts: ArtifactStore;
  /** Streaming upload cap; defaults to FILE_UPLOAD_MAX_BYTES (250 MiB). */
  maxFileUploadSizeBytes?: number;
}

export interface DriveUploadParams {
  folderId?: string | null;
  botId?: string | null;
  groupId?: string | null;
  runId?: string | null;
  source?: string | null;
  name?: string | null;
  description?: string | null;
  mimeType?: string | null;
  clientNonce?: string | null;
}

export interface DriveListInput {
  folderId?: string | null;
  allFolders?: boolean;
  botId?: string;
  madeByBots?: boolean;
  category?: FileCategory;
  query?: string;
  trashed?: boolean;
  sortBy?: FileSortBy;
  sortDir?: FileSortDir;
  cursor?: string;
  limit?: number;
}

export interface DriveChangesInput {
  cursor?: string;
  limit?: number;
}

export interface SpaceFileMeta {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  hash: string;
  storageKey: string;
}

/** An inclusive plaintext byte interval, like filestore.ByteRange. */
export interface DriveByteRange {
  start: number;
  endInclusive: number;
}

/** A caller action that failed on its input: bad name, blocked type, bad cursor, over limit. */
export class DriveValidationError extends ClientError {
  constructor(message: string) {
    super("BAD_REQUEST", message);
    this.name = "DriveValidationError";
  }
}

/** A streaming upload over the configured cap; the HTTP route answers 413 like Go. */
export class DriveFileTooLargeError extends DriveValidationError {
  constructor(maxBytes: number) {
    super(`File exceeds the ${attachmentSizeLabel(maxBytes)} limit`);
    this.name = "DriveFileTooLargeError";
  }
}

export class DriveNotFoundError extends ClientError {
  constructor(message = "File not found") {
    super("NOT_FOUND", message);
    this.name = "DriveNotFoundError";
  }
}

export class DriveConflictError extends ClientError {
  constructor(message: string) {
    super("CONFLICT", message);
    this.name = "DriveConflictError";
  }
}

export type DriveArtifactRow = {
  id: string;
  botId: string | null;
  groupId: string | null;
  runId: string | null;
  folderId: string | null;
  source: string;
  name: string;
  description: string | null;
  mimeType: string;
  size: number;
  hash: string;
  version: number;
  trashedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  rootArtifactId: string | null;
};

export type DriveFolderRow = {
  id: string;
  parentId: string | null;
  name: string;
  trashedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function formatTime(value: Date): string {
  return value.toISOString();
}

export function formatOptionalTime(value: Date | null): string | null {
  return value ? formatTime(value) : null;
}

function contentUrlFor(id: string): string {
  return `/api/v1/files/${encodeURIComponent(id)}/content`;
}

export function trimOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Core's validateDriveName throws AttachmentValidationError; the route layer speaks ClientError. */
export function driveName(raw: string): string {
  try {
    return validateDriveName(raw);
  } catch (error) {
    if (error instanceof AttachmentValidationError) throw new DriveValidationError(error.message);
    throw error;
  }
}

/** Go's filepolicy.fileExtensionLower, compound suffixes first. */
function driveExtension(name: string): string {
  const lower = name.trim().toLowerCase();
  for (const compound of COMPOUND_EXTENSIONS) {
    if (lower.endsWith(compound)) return compound;
  }
  const dot = lower.lastIndexOf(".");
  return dot < 0 ? "" : lower.slice(dot);
}

/**
 * Infers a Drive MIME type with Go's blocked dropper policy, which is broader than the
 * attachment policy in contracts (installers, drivers, control panels and browser apps).
 */
export function validateDriveUploadMimeType(name: string, reportedType?: string | null): string {
  if (BLOCKED_EXTENSIONS[driveExtension(name)]) {
    throw new DriveValidationError("Executable installer or binary file types are not permitted");
  }
  const reported = normalizeMimeType(reportedType ?? "");
  if (reported) {
    if (!MIME_SYNTAX.test(reported)) {
      throw new DriveValidationError(`Invalid MIME type "${reportedType ?? ""}"`);
    }
    if (BLOCKED_MIME_TYPES[reported]) {
      throw new DriveValidationError("Executable binary file types are not permitted");
    }
  }
  const mimeType = inferAttachmentMimeType(name, reported || undefined);
  if (!mimeType) {
    throw new DriveValidationError(`Unsupported or blocked file type for ${name}`);
  }
  return mimeType;
}

/** Go's normalizeFilename: browsers may send a path, keep only its base name. */
export function normalizeUploadFilename(raw: string): string {
  const cleaned = raw.replace(/\\/g, "/");
  const base = path.posix.basename(cleaned);
  return !base || base === "." || base === "/" ? "upload" : base;
}

/**
 * Rejects spoofed raster images and PDFs whose bytes do not match their claimed header, and
 * refuses active HTML/SVG markup hidden under a safe media type. Mirrors
 * filepolicy.SniffSafeUpload so a polyglot cannot reach the credentialed content origin.
 */
export function sniffSafeUpload(claimedMimeType: string, prefix: Uint8Array): void {
  const mimeType = normalizeMimeType(claimedMimeType);
  if (!mimeType) return;
  const bytes = Buffer.from(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  switch (mimeType) {
    case "image/jpeg":
      if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
        throw new DriveValidationError("File contents do not match JPEG header");
      }
      break;
    case "image/png": {
      const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (bytes.length < magic.length || !bytes.subarray(0, magic.length).equals(magic)) {
        throw new DriveValidationError("File contents do not match PNG header");
      }
      break;
    }
    case "image/gif":
      if (
        bytes.length < 6 ||
        (!bytes.subarray(0, 6).equals(Buffer.from("GIF87a")) &&
          !bytes.subarray(0, 6).equals(Buffer.from("GIF89a")))
      ) {
        throw new DriveValidationError("File contents do not match GIF header");
      }
      break;
    case "image/webp":
      if (
        bytes.length < 12 ||
        !bytes.subarray(0, 4).equals(Buffer.from("RIFF")) ||
        !bytes.subarray(8, 12).equals(Buffer.from("WEBP"))
      ) {
        throw new DriveValidationError("File contents do not match WebP header");
      }
      break;
    case "application/pdf": {
      const trimmed = trimLeading(bytes, Buffer.from(" \t\r\n"));
      if (!trimmed.includes("%PDF-")) {
        throw new DriveValidationError("File contents do not match PDF header");
      }
      break;
    }
    default:
      break;
  }

  // Guard safe raster/audio/video/pdf media against active markup polyglots.
  if (
    mimeType.startsWith("video/") ||
    mimeType.startsWith("audio/") ||
    (mimeType.startsWith("image/") && mimeType !== "image/svg+xml") ||
    mimeType === "application/pdf"
  ) {
    const sample = trimLeadingMarkupSpace(bytes).toString("utf8").toLowerCase();
    if (
      sample.startsWith("<!doctype html") ||
      sample.startsWith("<html") ||
      sample.startsWith("<script") ||
      sample.startsWith("<svg")
    ) {
      throw new DriveValidationError(
        "Media file contents cannot start with active HTML or SVG markup",
      );
    }
  }
}

function trimLeading(value: Buffer, bytes: Buffer): Buffer {
  let start = 0;
  while (start < value.length && bytes.includes(value[start]!)) start++;
  return value.subarray(start);
}

/** Go's TrimLeft with " \t\r\n\ufeff": ASCII whitespace and whole BOM runes, not BOM bytes. */
function trimLeadingMarkupSpace(value: Buffer): Buffer {
  let start = 0;
  for (;;) {
    const byte = value[start];
    if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a) {
      start++;
      continue;
    }
    if (value[start] === 0xef && value[start + 1] === 0xbb && value[start + 2] === 0xbf) {
      start += 3;
      continue;
    }
    break;
  }
  return value.subarray(start);
}

/**
 * Whether direct browser viewing on the API origin may render this type inline. Text/HTML,
 * SVG and script content always download, so the credentialed origin never runs user markup.
 */
export function isSafeInlineMedia(mimeType: string): boolean {
  const type = normalizeMimeType(mimeType);
  if (
    type === "image/svg+xml" ||
    type === "text/html" ||
    type === "application/xhtml+xml" ||
    type === "application/xml" ||
    type === "application/javascript"
  ) {
    return false;
  }
  if (type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/")) {
    return true;
  }
  switch (type) {
    case "application/pdf":
    case "text/plain":
    case "text/markdown":
    case "text/csv":
    case "text/tab-separated-values":
      return true;
    default:
      return false;
  }
}

/** A safe Content-Disposition value; control characters, slashes and quotes never leak. */
export function formatContentDisposition(inline: boolean, filename: string): string {
  const kind = inline ? "inline" : "attachment";
  const cleaned = [...(filename.trim() || "file")]
    .map((character) => {
      const code = character.codePointAt(0)!;
      return code < 0x20 ||
        code === 0x7f ||
        character === "/" ||
        character === "\\" ||
        character === '"'
        ? "_"
        : character;
    })
    .join("");
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, "_");
  if (ascii === cleaned) return `${kind}; filename="${ascii}"`;
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeRFC5987(cleaned)}`;
}

function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Parses an RFC 9110 single byte range. Multi-range requests are treated as full-body reads,
 * and a syntactically valid but unsatisfiable range returns `unsatisfiable: true` (HTTP 416).
 */
export function parseSingleByteRange(
  header: string,
  size: number,
): { range: DriveByteRange | null; unsatisfiable: boolean } {
  if (!header) return { range: null, unsatisfiable: false };
  if (!header.toLowerCase().startsWith("bytes=")) return { range: null, unsatisfiable: false };
  const spec = header.slice(6).trim();
  if (!spec || spec.includes(",")) return { range: null, unsatisfiable: false };
  const dash = spec.indexOf("-");
  if (dash < 0) return { range: null, unsatisfiable: true };
  const startText = spec.slice(0, dash).trim();
  const endText = spec.slice(dash + 1).trim();
  if (!startText && !endText) return { range: null, unsatisfiable: true };
  if (size <= 0) return { range: null, unsatisfiable: true };
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { range: null, unsatisfiable: true };
    if (suffix >= size)
      return { range: { start: 0, endInclusive: size - 1 }, unsatisfiable: false };
    return { range: { start: size - suffix, endInclusive: size - 1 }, unsatisfiable: false };
  }
  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) {
    return { range: null, unsatisfiable: true };
  }
  if (!endText) return { range: { start, endInclusive: size - 1 }, unsatisfiable: false };
  const parsedEnd = Number(endText);
  if (!Number.isSafeInteger(parsedEnd) || parsedEnd < start) {
    return { range: null, unsatisfiable: true };
  }
  return {
    range: { start, endInclusive: Math.min(parsedEnd, size - 1) },
    unsatisfiable: false,
  };
}

/** If-None-Match comparison; weak tags match like Go's drive handler. */
export function matchesIfNoneMatch(header: string, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate.replace(/^W\//, "") === etag);
}

export function toDriveFile(row: DriveArtifactRow, versionCount: number): DriveFile {
  return {
    id: row.id,
    botId: row.botId,
    groupId: row.groupId,
    runId: row.runId,
    folderId: row.folderId,
    // The column holds a validated source; old rows default to "chat".
    source: row.source as FileSource,
    name: row.name,
    description: row.description,
    mimeType: row.mimeType,
    size: row.size,
    hash: row.hash,
    version: row.version,
    versionCount: Math.max(versionCount, row.version),
    trashedAt: formatOptionalTime(row.trashedAt),
    createdAt: formatTime(row.createdAt),
    updatedAt: formatTime(row.updatedAt),
    contentUrl: contentUrlFor(row.id),
  };
}

/** Prepend the sniffed prefix and enforce the streaming upload cap. */
async function countFamily(
  prisma: Pick<PrismaClient, "artifact">,
  spaceId: string,
  familyId: string,
): Promise<number> {
  const rows = await prisma.artifact.findMany({
    where: {
      spaceId,
      OR: [{ id: familyId }, { rootArtifactId: familyId }],
    },
    select: { id: true },
  });
  return rows.length;
}

export async function driveFileFor(
  prisma: Pick<PrismaClient, "artifact">,
  spaceId: string,
  row: DriveArtifactRow,
): Promise<DriveFile> {
  const familyId = row.rootArtifactId ?? row.id;
  return toDriveFile(row, await countFamily(prisma, spaceId, familyId));
}

export type ListCursor = { key: string; size?: number; id: string };

export function encodeListCursor(cursor: ListCursor): string {
  const payload: Record<string, string | number> = { k: cursor.key };
  if (cursor.size !== undefined) payload.n = cursor.size;
  payload.i = cursor.id;
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeListCursor(raw: string): ListCursor | null {
  if (!raw) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new DriveValidationError("Invalid cursor");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new DriveValidationError("Invalid cursor");
  }
  if (typeof parsed !== "object" || parsed === null)
    throw new DriveValidationError("Invalid cursor");
  const record = parsed as Record<string, unknown>;
  if (typeof record.i !== "string" || !record.i) throw new DriveValidationError("Invalid cursor");
  const key = typeof record.k === "string" ? record.k : "";
  const size = typeof record.n === "number" ? record.n : undefined;
  return { key, size, id: record.i };
}

export function decodeCursorTimestamp(cursor: ListCursor): Date {
  const parsed = Date.parse(cursor.key);
  if (Number.isNaN(parsed)) throw new DriveValidationError("Invalid cursor timestamp");
  return new Date(parsed);
}

export function cursorForRow(row: DriveArtifactRow, sortBy: FileSortBy): ListCursor {
  if (sortBy === "name") return { key: row.name.toLowerCase(), id: row.id };
  if (sortBy === "size") return { key: "", size: row.size, id: row.id };
  return { key: row.updatedAt.toISOString(), id: row.id };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareLowerName(
  a: { name: string; id: string },
  b: { name: string; id: string },
): number {
  const left = a.name.toLowerCase();
  const right = b.name.toLowerCase();
  return left === right ? compareText(a.id, b.id) : compareText(left, right);
}

export async function loadBreadcrumbs(
  prisma: Pick<PrismaClient, "fileFolder">,
  spaceId: string,
  folderId: string,
): Promise<FolderBreadcrumb[]> {
  const breadcrumbs: FolderBreadcrumb[] = [];
  const seen = new Set<string>();
  let current: string | null = folderId;
  for (let depth = 0; current && depth < 30; depth++) {
    const folderIdInWalk: string = current;
    if (seen.has(folderIdInWalk)) throw new DriveNotFoundError("Folder not found");
    seen.add(folderIdInWalk);
    const folder: {
      id: string;
      parentId: string | null;
      name: string;
      trashedAt: Date | null;
    } | null = await prisma.fileFolder.findFirst({
      where: { id: folderIdInWalk, spaceId },
      select: { id: true, parentId: true, name: true, trashedAt: true },
    });
    if (!folder || folder.trashedAt) throw new DriveNotFoundError("Folder not found");
    breadcrumbs.push({ id: folder.id, name: folder.name });
    current = folder.parentId;
  }
  if (breadcrumbs.length === 0) throw new DriveNotFoundError("Folder not found");
  return breadcrumbs.reverse();
}

export function toFolderDto(row: DriveFolderRow): FileFolder {
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name,
    trashedAt: formatOptionalTime(row.trashedAt),
    createdAt: formatTime(row.createdAt),
    updatedAt: formatTime(row.updatedAt),
  };
}

/** files.list: breadcrumbs, child folders, latest-version files, filters, sort and cursor. */
export async function loadDriveFile(
  prisma: Pick<PrismaClient, "artifact">,
  spaceId: string,
  fileId: string,
): Promise<DriveFile> {
  const row = await prisma.artifact.findFirst({
    where: { id: fileId, spaceId },
    select: FILE_SELECT,
  });
  if (!row) throw new DriveNotFoundError("File not found");
  return driveFileFor(prisma, spaceId, row);
}
