import { createAdapterContext } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { ContentDecryptionError } from "@rakazo/db";
import type { DriveByteRange, DriveDeps, SpaceFileMeta } from "./common.js";
import { DriveNotFoundError } from "./common.js";

/** Content metadata and decrypted streams, optionally sliced to an inclusive byte range. */

export async function statSpaceFileContent(
  deps: Pick<DriveDeps, "prisma">,
  actor: Actor,
  fileId: string,
): Promise<SpaceFileMeta> {
  const row = await deps.prisma.artifact.findFirst({
    where: { id: fileId, spaceId: actor.spaceId },
    select: {
      id: true,
      name: true,
      mimeType: true,
      size: true,
      hash: true,
      storageKey: true,
      trashedAt: true,
    },
  });
  if (!row || row.trashedAt) throw new DriveNotFoundError("File not found");
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    hash: row.hash,
    storageKey: row.storageKey,
  };
}

/** Opens a decrypted stream, optionally sliced to an inclusive byte range. */
export async function openSpaceFileContent(
  deps: Pick<DriveDeps, "prisma" | "artifacts">,
  actor: Actor,
  fileId: string,
  byteRange: DriveByteRange | null,
): Promise<{ meta: SpaceFileMeta; stream: AsyncIterable<Uint8Array>; totalSize: number }> {
  const meta = await statSpaceFileContent(deps, actor, fileId);
  const context = createAdapterContext(actor, fileId, `drive-content:${fileId}`);
  let stream: AsyncIterable<Uint8Array>;
  try {
    if (deps.artifacts.getStream) {
      stream = await deps.artifacts.getStream(
        meta.storageKey,
        context,
        byteRange ? { range: byteRange } : undefined,
      );
    } else {
      // A store without streaming reads slices in memory; the built-in stores avoid this.
      const bytes = await deps.artifacts.get(meta.storageKey, context);
      const slice = byteRange
        ? bytes.subarray(byteRange.start, Math.min(byteRange.endInclusive + 1, bytes.byteLength))
        : bytes;
      stream = (async function* () {
        yield slice;
      })();
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "NoSuchKey")
    ) {
      throw new DriveNotFoundError("File contents not found");
    }
    if (error instanceof ContentDecryptionError) {
      throw new ClientError("FORBIDDEN", "Encrypted file could not be decrypted");
    }
    throw error;
  }
  return { meta, stream, totalSize: meta.size };
}

// ---------------------------------------------------------------------------------------------
// Listing, breadcrumbs and the Phase 4 delta feed.
// ---------------------------------------------------------------------------------------------
