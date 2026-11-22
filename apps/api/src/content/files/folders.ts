import { createAdapterContext } from "@rakazo/adapter-kit";
import type { Actor, FileFolder } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { isRecordNotFound, isUniqueViolation, Prisma } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { DriveDeps, DriveFolderRow } from "./common.js";
import {
  DriveConflictError,
  DriveNotFoundError,
  DriveValidationError,
  driveName,
  FOLDER_SELECT,
  loadBreadcrumbs,
  MAX_FOLDER_DEPTH,
  toFolderDto,
  trimOptional,
} from "./common.js";

/** Folder create, rename, move, Trash, restore and permanent delete. */

async function loadSpaceFolders(
  prisma: Pick<PrismaClient, "fileFolder">,
  spaceId: string,
): Promise<DriveFolderRow[]> {
  return prisma.fileFolder.findMany({ where: { spaceId }, select: FOLDER_SELECT });
}

/** All descendants of rootId (including it), across trashed and active folders. */
function descendantFolderIds(folders: DriveFolderRow[], rootId: string): string[] {
  const children = new Map<string, string[]>();
  for (const folder of folders) {
    if (!folder.parentId) continue;
    const bucket = children.get(folder.parentId);
    if (bucket) bucket.push(folder.id);
    else children.set(folder.parentId, [folder.id]);
  }
  const ids: string[] = [];
  const queue = [rootId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    queue.push(...(children.get(id) ?? []));
  }
  return ids;
}

/** Height of the active subtree rooted at rootId, counted like Go's recursive CTE. */
function activeSubtreeHeight(folders: DriveFolderRow[], rootId: string): number {
  const children = new Map<string, string[]>();
  for (const folder of folders) {
    if (!folder.parentId || folder.trashedAt) continue;
    const bucket = children.get(folder.parentId);
    if (bucket) bucket.push(folder.id);
    else children.set(folder.parentId, [folder.id]);
  }
  let height = 1;
  let level = [rootId];
  const seen = new Set<string>();
  while (level.length > 0) {
    const next: string[] = [];
    for (const id of level) {
      if (seen.has(id)) continue;
      seen.add(id);
      next.push(...(children.get(id) ?? []));
    }
    if (next.length === 0) break;
    height++;
    level = next;
  }
  return height;
}

async function folderRow(
  prisma: Pick<PrismaClient, "fileFolder">,
  spaceId: string,
  folderId: string,
): Promise<DriveFolderRow> {
  const row = await prisma.fileFolder.findFirst({
    where: { id: folderId, spaceId },
    select: FOLDER_SELECT,
  });
  if (!row) throw new DriveNotFoundError("Folder not found");
  return row;
}

export async function createDriveFolder(
  deps: Pick<DriveDeps, "prisma">,
  actor: Actor,
  input: { parentId?: string | null; name: string },
): Promise<FileFolder> {
  const name = driveName(input.name);
  const parentId = trimOptional(input.parentId);
  if (parentId) {
    const breadcrumbs = await loadBreadcrumbs(deps.prisma, actor.spaceId, parentId);
    if (breadcrumbs.length >= MAX_FOLDER_DEPTH) {
      throw new DriveValidationError("Folder nesting limit reached");
    }
  }
  try {
    const row = await deps.prisma.fileFolder.create({
      data: { spaceId: actor.spaceId, parentId, createdByUserId: actor.userId, name },
      select: FOLDER_SELECT,
    });
    return toFolderDto(row);
  } catch (error) {
    if (isUniqueViolation(error))
      throw new DriveConflictError("A folder with that name already exists here");
    throw error;
  }
}

export async function renameDriveFolder(
  deps: Pick<DriveDeps, "prisma">,
  actor: Actor,
  input: { folderId: string; name: string },
): Promise<FileFolder> {
  const name = driveName(input.name);
  const existing = await deps.prisma.fileFolder.findFirst({
    where: { id: input.folderId, spaceId: actor.spaceId, trashedAt: null },
    select: { id: true },
  });
  if (!existing) throw new DriveNotFoundError("Folder not found");
  try {
    const row = await deps.prisma.fileFolder.update({
      where: { id: existing.id },
      data: { name },
      select: FOLDER_SELECT,
    });
    return toFolderDto(row);
  } catch (error) {
    if (isRecordNotFound(error)) throw new DriveNotFoundError("Folder not found");
    if (isUniqueViolation(error))
      throw new DriveConflictError("A folder with that name already exists here");
    throw error;
  }
}

export async function moveDriveFolder(
  deps: Pick<DriveDeps, "prisma">,
  actor: Actor,
  input: { folderId: string; parentId: string | null },
): Promise<FileFolder> {
  const parentId = trimOptional(input.parentId);
  if (parentId && parentId === input.folderId) {
    throw new DriveValidationError("Cannot move a folder into itself");
  }
  const folder = await folderRow(deps.prisma, actor.spaceId, input.folderId);
  if (folder.trashedAt) throw new DriveNotFoundError("Folder not found");
  let parentDepth = 0;
  if (parentId) {
    const breadcrumbs = await loadBreadcrumbs(deps.prisma, actor.spaceId, parentId);
    if (breadcrumbs.some((crumb) => crumb.id === input.folderId)) {
      throw new DriveValidationError("Cannot move a folder into one of its descendants");
    }
    parentDepth = breadcrumbs.length;
  }
  const folders = await loadSpaceFolders(deps.prisma, actor.spaceId);
  if (parentDepth + activeSubtreeHeight(folders, input.folderId) > MAX_FOLDER_DEPTH) {
    throw new DriveValidationError("Folder nesting limit reached");
  }
  try {
    const row = await deps.prisma.fileFolder.update({
      where: { id: input.folderId },
      data: { parentId },
      select: FOLDER_SELECT,
    });
    return toFolderDto(row);
  } catch (error) {
    if (isUniqueViolation(error))
      throw new DriveConflictError("A folder with that name already exists here");
    throw error;
  }
}

export async function trashDriveFolder(
  deps: Pick<DriveDeps, "prisma">,
  actor: Actor,
  folderId: string,
): Promise<void> {
  const folder = await deps.prisma.fileFolder.findFirst({
    where: { id: folderId, spaceId: actor.spaceId },
    select: { id: true },
  });
  if (!folder) throw new DriveNotFoundError("Folder not found");
  const ids = descendantFolderIds(await loadSpaceFolders(deps.prisma, actor.spaceId), folderId);
  const now = new Date();
  await deps.prisma.fileFolder.updateMany({
    where: { spaceId: actor.spaceId, id: { in: ids }, trashedAt: null },
    data: { trashedAt: now },
  });
  await deps.prisma.fileFolder.updateMany({
    where: { spaceId: actor.spaceId, id: { in: ids } },
    data: { updatedAt: now },
  });
  await deps.prisma.artifact.updateMany({
    where: { spaceId: actor.spaceId, folderId: { in: ids }, trashedAt: null },
    data: { trashedAt: now },
  });
  await deps.prisma.artifact.updateMany({
    where: { spaceId: actor.spaceId, folderId: { in: ids } },
    data: { updatedAt: now },
  });
}

export async function restoreDriveFolder(
  deps: Pick<DriveDeps, "prisma">,
  actor: Actor,
  folderId: string,
): Promise<FileFolder> {
  const folder = await folderRow(deps.prisma, actor.spaceId, folderId);
  let parentId = folder.parentId;
  if (parentId) {
    const parent = await deps.prisma.fileFolder.findFirst({
      where: { id: parentId, spaceId: actor.spaceId },
      select: { id: true, trashedAt: true },
    });
    if (!parent || parent.trashedAt) parentId = null;
  }
  let restored: DriveFolderRow;
  try {
    restored = await deps.prisma.fileFolder.update({
      where: { id: folderId },
      data: { trashedAt: null, parentId },
      select: FOLDER_SELECT,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DriveConflictError("A folder with that name already exists in the destination");
    }
    throw error;
  }
  const ids = descendantFolderIds(await loadSpaceFolders(deps.prisma, actor.spaceId), folderId);
  const now = new Date();
  await deps.prisma.fileFolder.updateMany({
    where: { spaceId: actor.spaceId, id: { in: ids }, trashedAt: { not: null } },
    data: { trashedAt: null, updatedAt: now },
  });
  await deps.prisma.artifact.updateMany({
    where: { spaceId: actor.spaceId, folderId: { in: ids }, trashedAt: { not: null } },
    data: { trashedAt: null, updatedAt: now },
  });
  return toFolderDto(restored);
}

/** Deletes the folder, its descendant folders and their files; blobs go after the commit. */
export async function deleteDriveFolderPermanent(
  deps: DriveDeps,
  actor: Actor,
  folderId: string,
): Promise<void> {
  await folderRow(deps.prisma, actor.spaceId, folderId);
  const ids = descendantFolderIds(await loadSpaceFolders(deps.prisma, actor.spaceId), folderId);
  // RETURNING the keys keeps a version created during the delete from leaving an orphan blob.
  const deleted = await deps.prisma.$queryRaw<Array<{ storageKey: string }>>(Prisma.sql`
    DELETE FROM "artifacts"
    WHERE "spaceId" = ${actor.spaceId} AND "folderId" IN (${Prisma.join(ids)})
    RETURNING "storageKey"
  `);
  await deps.prisma.fileFolder.deleteMany({
    where: { spaceId: actor.spaceId, id: { in: ids } },
  });
  for (const row of deleted) {
    await bestEffort(
      "drive deleted-folder blob removal",
      deps.artifacts.remove(row.storageKey, createAdapterContext(actor, folderId, "drive-delete")),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// File operations.
// ---------------------------------------------------------------------------------------------
