-- Additive: older releases keep reading and writing file_folders and artifacts without reading botId or slug.
ALTER TABLE "file_folders" ADD COLUMN "botId" TEXT;

ALTER TABLE "file_folders" ADD CONSTRAINT "file_folders_botId_fkey"
    FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "file_folders_spaceId_botId_idx" ON "file_folders"("spaceId", "botId");

CREATE UNIQUE INDEX "file_folders_space_bot_key"
    ON "file_folders" ("spaceId", "botId")
    WHERE "botId" IS NOT NULL AND "trashedAt" IS NULL;

ALTER TABLE "artifacts" ADD COLUMN "slug" TEXT;

CREATE INDEX "artifacts_spaceId_slug_idx"
    ON "artifacts"("spaceId", "slug")
    WHERE "slug" IS NOT NULL AND "trashedAt" IS NULL;

-- Backfill searchable slugs for existing listed artifacts.
UPDATE "artifacts"
SET "slug" = COALESCE(
    NULLIF(
        LEFT(
            TRIM(BOTH '-' FROM REGEXP_REPLACE(
                LOWER(
                    CASE
                        WHEN position('.' in name) > 1
                             AND char_length(regexp_replace(name, '\.[^.]{1,12}$', '')) > 0
                        THEN regexp_replace(name, '\.[^.]{1,12}$', '')
                        ELSE name
                    END
                ),
                '[^a-z0-9]+',
                '-',
                'g'
            )),
            120
        ),
        ''
    ),
    'file'
)
WHERE "slug" IS NULL
  AND "mimeType" <> 'text/html;profile=mcp-app'
  AND "mimeType" NOT LIKE '%;profile=step-screenshot';

-- Backfill per-bot folders for existing active non-hidden artifacts created by bots at Space root.
DO $$
DECLARE
    rec RECORD;
    clean_name TEXT;
    candidate_name TEXT;
    target_folder_id TEXT;
    suffix INT;
BEGIN
    FOR rec IN
        SELECT DISTINCT ON (b.id)
            b.id AS bot_id,
            b."spaceId" AS space_id,
            b."userId" AS user_id,
            b.name AS bot_name
        FROM "bots" b
        JOIN "artifacts" a ON a."botId" = b.id AND a."spaceId" = b."spaceId"
        WHERE a."folderId" IS NULL
          AND a."trashedAt" IS NULL
          AND (a.source = 'bot' OR a."runId" IS NOT NULL)
          AND a."mimeType" <> 'text/html;profile=mcp-app'
          AND a."mimeType" NOT LIKE '%;profile=step-screenshot'
    LOOP
        SELECT id INTO target_folder_id
        FROM "file_folders"
        WHERE "spaceId" = rec.space_id AND "botId" = rec.bot_id AND "trashedAt" IS NULL
        LIMIT 1;

        IF target_folder_id IS NULL THEN
            clean_name := LEFT(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(rec.bot_name, ''), '[/\\\x00-\x1F\x7F]+', ' ', 'g'), '\s+', ' ', 'g')), 255);
            IF clean_name = '' OR clean_name = '.' OR clean_name = '..' THEN
                clean_name := 'Bot';
            END IF;

            SELECT id INTO target_folder_id
            FROM "file_folders"
            WHERE "spaceId" = rec.space_id
              AND "parentId" IS NULL
              AND "trashedAt" IS NULL
              AND "botId" IS NULL
              AND LOWER(name) = LOWER(clean_name)
            LIMIT 1;

            IF target_folder_id IS NOT NULL THEN
                UPDATE "file_folders"
                SET "botId" = rec.bot_id, "updatedAt" = NOW()
                WHERE id = target_folder_id AND "botId" IS NULL;
            ELSE
                candidate_name := clean_name;
                suffix := 2;
                LOOP
                    EXIT WHEN NOT EXISTS (
                        SELECT 1 FROM "file_folders"
                        WHERE "spaceId" = rec.space_id
                          AND "parentId" IS NULL
                          AND "trashedAt" IS NULL
                          AND LOWER(name) = LOWER(candidate_name)
                    );
                    candidate_name := LEFT(clean_name, 240) || ' (' || suffix || ')';
                    suffix := suffix + 1;
                END LOOP;

                target_folder_id := 'bf_' || REPLACE(gen_random_uuid()::text, '-', '');
                INSERT INTO "file_folders" (id, "spaceId", "parentId", "botId", "createdByUserId", name, "createdAt", "updatedAt")
                VALUES (target_folder_id, rec.space_id, NULL, rec.bot_id, rec.user_id, candidate_name, NOW(), NOW())
                ON CONFLICT DO NOTHING;

                SELECT id INTO target_folder_id
                FROM "file_folders"
                WHERE "spaceId" = rec.space_id AND "botId" = rec.bot_id AND "trashedAt" IS NULL
                LIMIT 1;
            END IF;
        END IF;

        IF target_folder_id IS NOT NULL THEN
            UPDATE "artifacts"
            SET "folderId" = target_folder_id, "updatedAt" = NOW()
            WHERE "spaceId" = rec.space_id
              AND "botId" = rec.bot_id
              AND "folderId" IS NULL
              AND "trashedAt" IS NULL
              AND (source = 'bot' OR "runId" IS NOT NULL)
              AND "mimeType" <> 'text/html;profile=mcp-app'
              AND "mimeType" NOT LIKE '%;profile=step-screenshot';
        END IF;
    END LOOP;
END $$;
