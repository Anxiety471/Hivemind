import { createAdapterContext } from "@rakazo/adapter-kit";
import type { Actor, DriveFile } from "@rakazo/contracts";
import { Prisma } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { DriveArtifactRow, DriveDeps } from "./common.js";
import {
  DriveNotFoundError,
  DriveValidationError,
  driveFileFor,
  driveName,
  FILE_SELECT,
  loadDriveFile,
  trimOptional,
} from "./common.js";

/** File rename, move, Trash, restore, permanent delete and empty-trash. */

export async function getDriveFile(
  deps: Pick<DriveDeps, "prisma">,
  actor: Actor,
  fileId: string,
): Promise<DriveFile> {
  const row = await deps.prisma.artifact.findFirst({
    where: { id: fileId, spaceId: actor.spaceId },
    select: FILE_SELECT,
  });
  if (!row) throw new DriveNotFoundError("File not found");
  return driveFileFor(deps.prisma, actor.spaceId, row);
}

/** files.folderTree: every active folder in the Space, for move dialogs and trees. */
async function familyRoot(row: Pick<DriveArtifactRow, "id" | "rootArtifactId">): Promise<string> {
  return row.rootArtifactId ?? row.id;
}

export async function renameDriveFile(
  deps: Pick<DriveDeps, "prisma">,
  actor: Actor,
  input: { fileId: string; name: string },
): Promise<DriveFile> {
  const name = driveName(input.name);
  const row = await deps.prisma.artifact.findFirst({
    where: { id: input.fileId, spaceId: actor.spaceId },
    select: { id: true, rootArtifactId: true },
  });
  if (!row) throw new DriveNotFoundError("File not found");
  const root = await familyRoot(row);
  await deps.prisma.artifact.updateMany({
    where: {
      spaceId: actor.spaceId,
      OR: [{ id: root }, { rootArtifactId: root }],
    },
    data: { name, updatedAt: new Date() },
  });
  return loadDriveFile(deps.prisma, actor.spaceId, input.fileId);
}

export async function moveDriveFile(
  deps: Pick<DriveDeps, "prisma">,
  actor: Actor,
  input: { fileId: string; folderId: string | null },
): Promise<DriveFile> {
  const folderId = trimOptional(input.folderId);
  if (folderId) {
    const folder = await deps.prisma.fileFolder.findFirst({
      where: { id: folderId, spaceId: actor.spaceId },
      select: { id: true, trashedAt: true },
    });
    if (!folder) throw new DriveNotFoundError("Destination folder not found");
    if (folder.trashedAt) throw new DriveValidationError("Cannot move into a trashed folder");
  }
  const row = await deps.prisma.artifact.findFirst({
    where: { id: input.fileId, spaceId: actor.spaceId, trashedAt: null },
    select: { id: true, rootArtifactId: true },
  });
  if (!row) throw new DriveNotFoundError("File not found");
  const root = await familyRoot(row);
  await deps.prisma.artifact.updateMany({
    where: {
      spaceId: actor.spaceId,
      OR: [{ id: root }, { rootArtifactId: root }],
    },
    data: { folderId, updatedAt: new Date() },
  });
  return loadDriveFile(deps.prisma, actor.spaceId, input.fileId);
}

export async function trashDriveFile(
  deps: Pick<DriveDeps, "prisma">,
  actor: Actor,
  fileId: string,
): Promise<void> {
  const row = await deps.prisma.artifact.findFirst({
    where: { id: fileId, spaceId: actor.spaceId },
    select: { id: true, rootArtifactId: true },
  });
  if (!row) throw new DriveNotFoundError("File not found");
  const root = await familyRoot(row);
  const now = new Date();
  await deps.prisma.artifact.updateMany({
    where: {
      spaceId: actor.spaceId,
      OR: [{ id: root }, { rootArtifactId: root }],
      trashedAt: null,
    },
    data: { trashedAt: now },
  });
  await deps.prisma.artifact.updateMany({
    where: {
      spaceId: actor.spaceId,
      OR: [{ id: root }, { rootArtifactId: root }],
    },
    data: { updatedAt: now },
  });
}

export async function restoreDriveFile(
  deps: Pick<DriveDeps, "prisma">,
  actor: Actor,
  fileId: string,
): Promise<DriveFile> {
  const row = await deps.prisma.artifact.findFirst({
    where: { id: fileId, spaceId: actor.spaceId },
    select: { id: true, rootArtifactId: true, folderId: true },
  });
  if (!row) throw new DriveNotFoundError("File not found");
  let folderId = row.folderId;
  if (folderId) {
    const folder = await deps.prisma.fileFolder.findFirst({
      where: { id: folderId, spaceId: actor.spaceId },
      select: { id: true, trashedAt: true },
    });
    if (!folder || folder.trashedAt) folderId = null;
  }
  const root = await familyRoot(row);
  await deps.prisma.artifact.updateMany({
    where: {
      spaceId: actor.spaceId,
      OR: [{ id: root }, { rootArtifactId: root }],
    },
    data: { trashedAt: null, folderId, updatedAt: new Date() },
  });
  return loadDriveFile(deps.prisma, actor.spaceId, fileId);
}

/** Deletes every version's row and blob; deletion returns the keys so none is orphaned. */
export async function deleteDriveFilePermanent(
  deps: DriveDeps,
  actor: Actor,
  fileId: string,
): Promise<void> {
  const row = await deps.prisma.artifact.findFirst({
    where: { id: fileId, spaceId: actor.spaceId },
    select: { id: true, rootArtifactId: true },
  });
  if (!row) throw new DriveNotFoundError("File not found");
  const root = await familyRoot(row);
  const deleted = await deps.prisma.$queryRaw<Array<{ storageKey: string }>>(Prisma.sql`
    DELETE FROM "artifacts"
    WHERE "spaceId" = ${actor.spaceId} AND (id = ${root} OR "rootArtifactId" = ${root})
    RETURNING "storageKey"
  `);
  for (const member of deleted) {
    await bestEffort(
      "drive deleted-file blob removal",
      deps.artifacts.remove(member.storageKey, createAdapterContext(actor, fileId, "drive-delete")),
    );
  }
}

/** Empties Trash: every trashed file version and trashed folder, then their blobs. */
export async function emptyDriveTrash(deps: DriveDeps, actor: Actor): Promise<number> {
  const deleted = await deps.prisma.$queryRaw<Array<{ storageKey: string }>>(Prisma.sql`
    DELETE FROM "artifacts"
    WHERE "spaceId" = ${actor.spaceId} AND "trashedAt" IS NOT NULL
    RETURNING "storageKey"
  `);
  await deps.prisma.fileFolder.deleteMany({
    where: { spaceId: actor.spaceId, trashedAt: { not: null } },
  });
  for (const row of deleted) {
    await bestEffort(
      "drive empty-trash blob removal",
      deps.artifacts.remove(
        row.storageKey,
        createAdapterContext(actor, actor.userId, "drive-empty-trash"),
      ),
    );
  }
  return deleted.length;
}
