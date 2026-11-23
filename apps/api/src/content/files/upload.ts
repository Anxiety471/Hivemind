import { createHash } from "node:crypto";
import { createAdapterContext } from "@rakazo/adapter-kit";
import type { Actor, DriveFile } from "@rakazo/contracts";
import { ARTIFACT_DESCRIPTION_MAX_LENGTH, FILE_UPLOAD_MAX_BYTES } from "@rakazo/contracts";
import { slugifyFileName } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { ensureBotDriveFolder, isUniqueViolation, withResolvedArtifactVersion } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { DriveArtifactRow, DriveDeps, DriveUploadParams } from "./common.js";
import {
  DriveConflictError,
  DriveFileTooLargeError,
  DriveNotFoundError,
  DriveValidationError,
  driveFileFor,
  driveName,
  driveSlug,
  FILE_SELECT,
  FILE_SOURCES,
  normalizeUploadFilename,
  SNIFF_BYTES,
  sniffSafeUpload,
  trimOptional,
  validateDriveUploadMimeType,
} from "./common.js";

/** Streaming uploads: sniff, cap, store, then insert the next artifact version. */

async function* withPrefixAndLimit(
  prefix: Uint8Array,
  rest: AsyncIterable<Uint8Array>,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  let seen = 0;
  async function* bounded(source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      seen += chunk.byteLength;
      if (seen > maxBytes) throw new DriveFileTooLargeError(maxBytes);
      yield chunk;
    }
  }
  yield* bounded(
    (async function* () {
      if (prefix.byteLength > 0) yield prefix;
      yield* rest;
    })(),
  );
}

/** Split the first SNIFF_BYTES off a stream while keeping the remainder iterable. */
async function takePrefix(
  source: AsyncIterable<Uint8Array>,
  size: number,
): Promise<{ prefix: Uint8Array; rest: AsyncIterable<Uint8Array> }> {
  const iterator = source[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < size) {
    const next = await iterator.next();
    if (next.done) break;
    chunks.push(next.value);
    total += next.value.byteLength;
  }
  const joined =
    chunks.length === 0
      ? Buffer.alloc(0)
      : Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  const prefix = joined.subarray(0, Math.min(size, joined.length));
  const overflow = joined.subarray(Math.min(size, joined.length));
  const rest: AsyncIterable<Uint8Array> = (async function* () {
    if (overflow.byteLength > 0) yield new Uint8Array(overflow);
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  })();
  return { prefix, rest };
}

async function findByClientNonce(
  prisma: Pick<PrismaClient, "artifact">,
  actor: Actor,
  clientNonce: string,
): Promise<DriveArtifactRow | null> {
  const row = await prisma.artifact.findFirst({
    where: { spaceId: actor.spaceId, userId: actor.userId, clientNonce },
    select: FILE_SELECT,
  });
  return row ?? null;
}

/**
 * Validates metadata and sniffed bytes, streams the upload into the artifact store in constant
 * memory, then inserts the next version. A failed insert removes its blob, and a retried
 * clientNonce returns the row the first attempt committed.
 */
export async function uploadSpaceFileStream(
  deps: DriveDeps,
  actor: Actor,
  params: DriveUploadParams,
  source: AsyncIterable<Uint8Array>,
): Promise<DriveFile> {
  const name = driveName(normalizeUploadFilename(params.name ?? ""));
  const mimeType = validateDriveUploadMimeType(name, params.mimeType);
  const sourceValue = params.source?.trim() || "upload";
  if (!FILE_SOURCES[sourceValue]) throw new DriveValidationError("Invalid file source");
  const description = trimOptional(params.description);
  if (description && [...description].length > ARTIFACT_DESCRIPTION_MAX_LENGTH) {
    throw new DriveValidationError(
      `Description exceeds ${ARTIFACT_DESCRIPTION_MAX_LENGTH} characters`,
    );
  }
  const folderIdArg = trimOptional(params.folderId);
  const botId = trimOptional(params.botId);
  const groupId = trimOptional(params.groupId);
  const runId = trimOptional(params.runId);
  const clientNonce = trimOptional(params.clientNonce);
  const rawSlug = trimOptional(params.slug);
  const slug = rawSlug ? driveSlug(rawSlug) : slugifyFileName(name);
  const maxBytes = deps.maxFileUploadSizeBytes ?? FILE_UPLOAD_MAX_BYTES;

  const { prefix, rest } = await takePrefix(source, SNIFF_BYTES);
  sniffSafeUpload(mimeType, prefix);

  if (clientNonce) {
    const existing = await findByClientNonce(deps.prisma, actor, clientNonce);
    if (existing) return driveFileFor(deps.prisma, actor.spaceId, existing);
  }
  if (folderIdArg) {
    const folder = await deps.prisma.fileFolder.findFirst({
      where: { id: folderIdArg, spaceId: actor.spaceId },
      select: { id: true, trashedAt: true },
    });
    if (!folder) throw new DriveNotFoundError("Folder not found");
    if (folder.trashedAt) throw new DriveValidationError("Cannot upload into a trashed folder");
  }
  if (botId) {
    const bot = await deps.prisma.bot.findFirst({
      where: { id: botId, spaceId: actor.spaceId },
      select: { id: true },
    });
    if (!bot) throw new DriveNotFoundError("Bot not found");
  }
  if (groupId) {
    const group = await deps.prisma.chatGroup.findFirst({
      where: { id: groupId, spaceId: actor.spaceId },
      select: { id: true },
    });
    if (!group) throw new DriveNotFoundError("Group not found");
  }
  const folderId =
    folderIdArg ??
    (sourceValue === "bot" && botId && "fileFolder" in deps.prisma && deps.prisma.fileFolder
      ? await ensureBotDriveFolder(deps.prisma, {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId,
        })
      : null);

  const context = createAdapterContext(
    actor,
    botId ?? groupId ?? actor.userId,
    `drive-upload:${clientNonce ?? name}`,
  );
  const limited = withPrefixAndLimit(prefix, rest, maxBytes);
  let stored: { id: string; hash: string; size: number };
  if (deps.artifacts.putStream) {
    stored = await deps.artifacts.putStream({ name, mimeType, stream: limited }, context);
  } else {
    const chunks: Uint8Array[] = [];
    let seen = 0;
    for await (const chunk of limited) {
      seen += chunk.byteLength;
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const put = await deps.artifacts.put({ name, mimeType, bytes }, context);
    stored = {
      id: put.id,
      hash: createHash("sha256").update(bytes).digest("hex"),
      size: seen,
    };
  }

  let replayed: DriveArtifactRow | null = null;
  let created: DriveArtifactRow;
  try {
    created = await withResolvedArtifactVersion(
      deps.prisma,
      { spaceId: actor.spaceId, botId, groupId, folderId, name },
      async (tx, { rootArtifactId, version }) => {
        if (clientNonce) {
          const raced: DriveArtifactRow | null = await tx.artifact.findFirst({
            where: { spaceId: actor.spaceId, userId: actor.userId, clientNonce },
            select: FILE_SELECT,
          });
          if (raced) {
            replayed = raced;
            return raced;
          }
        }
        return tx.artifact.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId,
            groupId,
            folderId,
            runId,
            source: sourceValue,
            name,
            slug,
            description,
            mimeType,
            size: stored.size,
            hash: stored.hash,
            storageKey: stored.id,
            rootArtifactId,
            version,
            clientNonce,
          },
        });
      },
    );
  } catch (error) {
    await bestEffort("drive upload remove orphan blob", deps.artifacts.remove(stored.id, context));
    if (isUniqueViolation(error)) throw new DriveConflictError("Upload conflict");
    throw error;
  }
  if (replayed) {
    await bestEffort(
      "drive upload remove duplicate blob",
      deps.artifacts.remove(stored.id, context),
    );
  }
  return driveFileFor(deps.prisma, actor.spaceId, created);
}

/** Metadata for a content read; a trashed file is not served even with its id. */
