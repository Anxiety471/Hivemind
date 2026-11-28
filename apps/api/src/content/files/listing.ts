import type {
  Actor,
  DriveFile,
  DriveFolderTreeEntry,
  FileCategory,
  FileFolder,
  FileSortBy,
  FileSortDir,
  FolderBreadcrumb,
} from "@rakazo/contracts";
import { ATTACHMENT_ARCHIVE_MIME_TYPES, ATTACHMENT_DOCUMENT_MIME_TYPES } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { HIDDEN_ARTIFACT_MIME_TYPES, Prisma } from "@rakazo/db";
import type {
  DriveArtifactRow,
  DriveDeps,
  DriveFolderRow,
  DriveListInput,
  ListCursor,
} from "./common.js";
import {
  compareLowerName,
  cursorForRow,
  DEFAULT_LIST_LIMIT,
  DRIVE_CODE_MIME_TYPES,
  DriveValidationError,
  decodeCursorTimestamp,
  decodeListCursor,
  encodeListCursor,
  FILE_CATEGORIES,
  FOLDER_SELECT,
  loadBreadcrumbs,
  MAX_LIST_LIMIT,
  toDriveFile,
  toFolderDto,
  trimOptional,
} from "./common.js";

/** files.list: SQL paging, breadcrumbs and the child-folder view. */

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function fileCategorySql(category: FileCategory): Prisma.Sql {
  switch (category) {
    case "video":
      return Prisma.sql`l."mimeType" LIKE 'video/%'`;
    case "image":
      return Prisma.sql`l."mimeType" LIKE 'image/%'`;
    case "audio":
      return Prisma.sql`l."mimeType" LIKE 'audio/%'`;
    case "archive":
      return Prisma.sql`l."mimeType" IN (${Prisma.join(ATTACHMENT_ARCHIVE_MIME_TYPES)})`;
    case "code":
      return Prisma.sql`l."mimeType" IN (${Prisma.join(DRIVE_CODE_MIME_TYPES)})`;
    case "document":
      // Go folds non-code text into documents; code types stay out.
      return Prisma.sql`(l."mimeType" IN (${Prisma.join(ATTACHMENT_DOCUMENT_MIME_TYPES)}) OR (l."mimeType" LIKE 'text/%' AND NOT (l."mimeType" IN (${Prisma.join(DRIVE_CODE_MIME_TYPES)}))))`;
    default:
      throw new DriveValidationError("Invalid file category");
  }
}

/**
 * Go's listFilesTx as Prisma SQL: the latest version per family, the family's version count,
 * filters, sort and cursor order all run in the database, and LIMIT bounds what is read.
 */
function driveFilesSql(input: {
  spaceId: string;
  folderId: string | null;
  allFolders: boolean;
  botId: string | null;
  madeByBots: boolean;
  category: FileCategory;
  query: string;
  trashed: boolean;
  sortBy: FileSortBy;
  sortDir: FileSortDir;
  cursor: ListCursor | null;
  limit: number;
}): Prisma.Sql {
  const cteConditions = [
    Prisma.sql`a."spaceId" = ${input.spaceId}`,
    input.trashed ? Prisma.sql`a."trashedAt" IS NOT NULL` : Prisma.sql`a."trashedAt" IS NULL`,
    Prisma.sql`a."mimeType" NOT IN (${Prisma.join(HIDDEN_ARTIFACT_MIME_TYPES)})`,
  ];
  const outerConditions: Prisma.Sql[] = [];
  if (!input.trashed && !input.allFolders) {
    outerConditions.push(
      input.folderId
        ? Prisma.sql`l."folderId" = ${input.folderId}`
        : Prisma.sql`l."folderId" IS NULL`,
    );
  }
  if (input.botId) outerConditions.push(Prisma.sql`l."botId" = ${input.botId}`);
  else if (input.madeByBots) outerConditions.push(Prisma.sql`l."botId" IS NOT NULL`);
  if (input.query) {
    const pattern = `%${escapeLike(input.query)}%`;
    outerConditions.push(
      Prisma.sql`(l.name ILIKE ${pattern} ESCAPE '\\' OR COALESCE(l.description, '') ILIKE ${pattern} ESCAPE '\\' OR COALESCE(l.slug, '') ILIKE ${pattern} ESCAPE '\\')`,
    );
  }
  if (input.category !== "all") outerConditions.push(fileCategorySql(input.category));

  const direction = input.sortDir === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  const comparator = input.sortDir === "desc" ? Prisma.sql`<` : Prisma.sql`>`;
  let orderBy: Prisma.Sql;
  if (input.sortBy === "name") {
    orderBy = Prisma.sql`LOWER(l.name) ${direction}, l.id ${direction}`;
    if (input.cursor)
      outerConditions.push(
        Prisma.sql`(LOWER(l.name), l.id) ${comparator} (${input.cursor.key}, ${input.cursor.id})`,
      );
  } else if (input.sortBy === "size") {
    orderBy = Prisma.sql`l.size ${direction}, l.id ${direction}`;
    if (input.cursor)
      outerConditions.push(
        Prisma.sql`(l.size, l.id) ${comparator} (${input.cursor.size ?? 0}, ${input.cursor.id})`,
      );
  } else {
    orderBy = Prisma.sql`l."updatedAt" ${direction}, l.id ${direction}`;
    if (input.cursor) {
      outerConditions.push(
        Prisma.sql`(l."updatedAt", l.id) ${comparator} (${decodeCursorTimestamp(input.cursor)}, ${input.cursor.id})`,
      );
    }
  }
  const outerWhere =
    outerConditions.length === 0 ? Prisma.sql`TRUE` : Prisma.join(outerConditions, " AND ");

  return Prisma.sql`
    WITH families AS (
      SELECT DISTINCT ON (COALESCE(a."rootArtifactId", a.id))
        a.id, a."botId", a."groupId", a."runId", a."folderId", a.source,
        a.name, a.slug, a.description, a."mimeType", a.size, a.hash, a.version,
        a."trashedAt", a."createdAt", a."updatedAt",
        COALESCE(a."rootArtifactId", a.id) AS family_id
      FROM "artifacts" a
      WHERE ${Prisma.join(cteConditions, " AND ")}
      ORDER BY COALESCE(a."rootArtifactId", a.id), a.version DESC, a."createdAt" DESC
    ),
    counts AS (
      SELECT COALESCE("rootArtifactId", id) AS family_id, COUNT(*)::int AS version_count
      FROM "artifacts"
      WHERE "spaceId" = ${input.spaceId}
      GROUP BY 1
    )
    SELECT l.id, l."botId", l."groupId", l."runId", l."folderId", l.source,
           l.name, l.slug, l.description, l."mimeType", l.size, l.hash, l.version,
           l."trashedAt", l."createdAt", l."updatedAt",
           c.version_count AS "versionCount"
    FROM families l
    JOIN counts c ON c.family_id = l.family_id
    WHERE ${outerWhere}
    ORDER BY ${orderBy}
    LIMIT ${input.limit + 1}
  `;
}

type DriveListRow = DriveArtifactRow & { versionCount: number };

async function loadListFolders(
  prisma: Pick<PrismaClient, "fileFolder">,
  spaceId: string,
  folderId: string | null,
  query: string,
  trashed: boolean,
): Promise<FileFolder[]> {
  const rows: DriveFolderRow[] = await prisma.fileFolder.findMany({
    where: {
      spaceId,
      ...(trashed
        ? { trashedAt: { not: null } }
        : { trashedAt: null, ...(folderId ? { parentId: folderId } : { parentId: null }) }),
      ...(query ? { name: { contains: query, mode: "insensitive" as const } } : {}),
    },
    select: FOLDER_SELECT,
  });
  return [...rows].sort(compareLowerName).map(toFolderDto);
}

export async function listDriveFiles(
  deps: Pick<DriveDeps, "prisma">,
  actor: Actor,
  input: DriveListInput,
) {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  const sortBy: FileSortBy = input.sortBy ?? "updatedAt";
  if (sortBy !== "updatedAt" && sortBy !== "name" && sortBy !== "size") {
    throw new DriveValidationError("Invalid sortBy");
  }
  const sortDir: FileSortDir = input.sortDir ?? (sortBy === "name" ? "asc" : "desc");
  if (sortDir !== "asc" && sortDir !== "desc") throw new DriveValidationError("Invalid sortDir");
  const cursor = decodeListCursor(input.cursor ?? "");
  const folderId = trimOptional(input.folderId);
  const query = input.query?.trim() ?? "";
  const category = input.category ?? "all";
  if (!FILE_CATEGORIES[category]) throw new DriveValidationError("Invalid file category");
  const trashed = input.trashed ?? false;
  const allFolders = input.allFolders ?? false;
  const botId = trimOptional(input.botId);
  const madeByBots = input.madeByBots ?? false;

  const result: {
    breadcrumbs: FolderBreadcrumb[];
    folders: FileFolder[];
    files: DriveFile[];
    nextCursor: string | null;
  } = { breadcrumbs: [], folders: [], files: [], nextCursor: null };

  if (folderId && !allFolders && !trashed) {
    result.breadcrumbs = await loadBreadcrumbs(deps.prisma, actor.spaceId, folderId);
  }
  if (!allFolders && category === "all" && !botId && !madeByBots && !cursor) {
    result.folders = await loadListFolders(deps.prisma, actor.spaceId, folderId, query, trashed);
  }

  const rows = await deps.prisma.$queryRaw<DriveListRow[]>(
    driveFilesSql({
      spaceId: actor.spaceId,
      folderId,
      allFolders,
      botId,
      madeByBots,
      category,
      query,
      trashed,
      sortBy,
      sortDir,
      cursor,
      limit,
    }),
  );
  const page = rows.slice(0, limit);
  result.files = page.map((row) => {
    const { versionCount, ...artifactRow } = row;
    return toDriveFile(artifactRow, versionCount);
  });
  const last = page.at(-1);
  if (rows.length > limit && last) {
    result.nextCursor = encodeListCursor(cursorForRow(last, sortBy));
  }
  return result;
}

/** files.get: one file (trashed included, like the Go preview). */
export async function getDriveFolderTree(
  deps: Pick<DriveDeps, "prisma">,
  actor: Actor,
): Promise<DriveFolderTreeEntry[]> {
  const rows = await deps.prisma.fileFolder.findMany({
    where: { spaceId: actor.spaceId, trashedAt: null },
    select: { id: true, parentId: true, botId: true, name: true },
  });
  return [...rows].sort(compareLowerName).map((row) => ({
    id: row.id,
    parentId: row.parentId,
    botId: row.botId ?? null,
    name: row.name,
  }));
}
