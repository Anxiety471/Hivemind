import type { Actor } from "@rakazo/contracts";
import { Prisma } from "@rakazo/db";
import type { DriveChangesInput, DriveDeps, ListCursor } from "./common.js";
import {
  DEFAULT_CHANGE_LIMIT,
  decodeCursorTimestamp,
  decodeListCursor,
  encodeListCursor,
  formatOptionalTime,
  formatTime,
  MAX_CHANGE_LIMIT,
} from "./common.js";

/** files.changes: the Phase 4 delta feed, ordered (updatedAt ASC, id ASC). */

type DriveChangeRow = {
  kind: "file" | "folder";
  id: string;
  parentId: string | null;
  name: string;
  trashedAt: Date | null;
  updatedAt: Date;
  hash: string | null;
  size: number | null;
  mimeType: string | null;
  version: number | null;
};

/** Go's Changes query: folders and latest file versions merged, ordered by (updatedAt, id). */
function driveChangesSql(spaceId: string, cursor: ListCursor | null, limit: number): Prisma.Sql {
  const cursorCondition = cursor
    ? Prisma.sql`(u."updatedAt", u.id) > (${decodeCursorTimestamp(cursor)}, ${cursor.id})`
    : Prisma.sql`TRUE`;
  return Prisma.sql`
    WITH combined AS (
      SELECT 'folder'::text AS kind, id, "parentId", name, "trashedAt", "updatedAt",
             NULL::text AS hash, NULL::int AS size, NULL::text AS "mimeType", NULL::int AS version
      FROM "file_folders"
      WHERE "spaceId" = ${spaceId}
      UNION ALL
      (
        SELECT DISTINCT ON (COALESCE(a."rootArtifactId", a.id))
               'file'::text AS kind, a.id, a."folderId" AS "parentId", a.name,
               a."trashedAt", a."updatedAt", a.hash, a.size, a."mimeType", a.version
        FROM "artifacts" a
        WHERE a."spaceId" = ${spaceId}
        ORDER BY COALESCE(a."rootArtifactId", a.id), a.version DESC, a."createdAt" DESC
      )
    )
    SELECT kind, id, "parentId", name, "trashedAt", "updatedAt", hash, size, "mimeType", version
    FROM combined u
    WHERE ${cursorCondition}
    ORDER BY u."updatedAt" ASC, u.id ASC
    LIMIT ${limit + 1}
  `;
}

/** files.changes: everything updated after the cursor, ordered (updatedAt ASC, id ASC). */
export async function listDriveChanges(
  deps: Pick<DriveDeps, "prisma">,
  actor: Actor,
  input: DriveChangesInput,
) {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_CHANGE_LIMIT, 1), MAX_CHANGE_LIMIT);
  const cursor = decodeListCursor(input.cursor ?? "");
  const rows = await deps.prisma.$queryRaw<DriveChangeRow[]>(
    driveChangesSql(actor.spaceId, cursor, limit),
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      kind: row.kind,
      id: row.id,
      parentId: row.parentId,
      name: row.name,
      trashedAt: formatOptionalTime(row.trashedAt),
      updatedAt: formatTime(row.updatedAt),
      hash: row.hash,
      size: row.size,
      mimeType: row.mimeType,
      version: row.version,
    })),
    nextCursor: last ? encodeListCursor({ key: last.updatedAt.toISOString(), id: last.id }) : null,
    hasMore: rows.length > limit,
  };
}

// ---------------------------------------------------------------------------------------------
// Folder operations.
// ---------------------------------------------------------------------------------------------
