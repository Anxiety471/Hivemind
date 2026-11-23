-- Additive: gives every active bot its Space Drive folder (previously created on first file).
DO $$
DECLARE
    rec RECORD;
    clean_name TEXT;
    candidate_name TEXT;
    adopt_id TEXT;
    suffix INT;
BEGIN
    FOR rec IN
        SELECT b.id AS bot_id, b."spaceId" AS space_id, b."userId" AS user_id, b.name AS bot_name
        FROM "bots" b
        WHERE b."archivedAt" IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM "file_folders" f
              WHERE f."spaceId" = b."spaceId" AND f."botId" = b.id AND f."trashedAt" IS NULL
          )
        ORDER BY b."createdAt"
    LOOP
        clean_name := LEFT(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(rec.bot_name, ''), '[/\\\x00-\x1F\x7F]+', ' ', 'g'), '\s+', ' ', 'g')), 255);
        IF clean_name = '' OR clean_name = '.' OR clean_name = '..' THEN
            clean_name := 'Bot';
        END IF;

        adopt_id := NULL;
        SELECT id INTO adopt_id
        FROM "file_folders"
        WHERE "spaceId" = rec.space_id
          AND "parentId" IS NULL
          AND "trashedAt" IS NULL
          AND "botId" IS NULL
          AND LOWER(name) = LOWER(clean_name)
        LIMIT 1;

        IF adopt_id IS NOT NULL THEN
            UPDATE "file_folders" SET "botId" = rec.bot_id, "updatedAt" = NOW() WHERE id = adopt_id;
        ELSE
            candidate_name := clean_name;
            suffix := 2;
            LOOP
                EXIT WHEN NOT EXISTS (
                    SELECT 1 FROM "file_folders"
                    WHERE "spaceId" = rec.space_id
                      AND "parentId" IS NULL
                      AND LOWER(name) = LOWER(candidate_name)
                );
                candidate_name := LEFT(clean_name, 240) || ' (' || suffix || ')';
                suffix := suffix + 1;
            END LOOP;

            INSERT INTO "file_folders" (id, "spaceId", "parentId", "botId", "createdByUserId", name, "createdAt", "updatedAt")
            VALUES ('bf_' || REPLACE(gen_random_uuid()::text, '-', ''), rec.space_id, NULL, rec.bot_id, rec.user_id, candidate_name, NOW(), NOW())
            ON CONFLICT DO NOTHING;
        END IF;
    END LOOP;
END $$;
