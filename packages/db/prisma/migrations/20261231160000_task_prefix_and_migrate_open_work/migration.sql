-- Switch default board ticket prefix from RAK to TASK and rename existing default boards.
ALTER TABLE "boards" ALTER COLUMN "ticketPrefix" SET DEFAULT 'TASK';
UPDATE "boards" SET "ticketPrefix" = 'TASK' WHERE "ticketPrefix" = 'RAK';

-- Ensure every Space with open/parked scratchpad items has a board before migration.
INSERT INTO "boards" ("id", "spaceId", "name", "ticketPrefix", "nextNumber", "createdAt", "updatedAt")
SELECT
  'brd_' || substr(md5(s.id || ':board'), 1, 20),
  s.id,
  COALESCE(NULLIF(trim(s.name), ''), 'Board'),
  'TASK',
  1,
  NOW(),
  NOW()
FROM "spaces" s
WHERE EXISTS (
  SELECT 1 FROM "scratchpad_items" sp
  WHERE sp."spaceId" = s.id AND sp."status" IN ('open', 'parked')
)
ON CONFLICT ("spaceId") DO NOTHING;

-- Migrate open and parked scratchpad ("Open work") items into Kanban tickets so
-- bots track them in one place and receive idle-bot bump reminders.
WITH to_migrate AS (
  SELECT
    sp.id AS scratchpad_id,
    sp."spaceId",
    b.id AS board_id,
    b."nextNumber" + ROW_NUMBER() OVER (PARTITION BY b.id ORDER BY sp."createdAt" ASC, sp.id ASC) - 1 AS ticket_number,
    LEFT(trim(sp.title), 200) AS title,
    NULLIF(trim(sp.notes), '') AS description,
    CASE WHEN sp.status = 'open' THEN 'doing' ELSE 'todo' END AS status,
    sp."botId",
    CASE WHEN EXISTS (SELECT 1 FROM "user" u WHERE u.id = sp."userId") THEN sp."userId" ELSE NULL END AS creator_user_id,
    sp."createdAt",
    sp."updatedAt"
  FROM "scratchpad_items" sp
  JOIN "boards" b ON b."spaceId" = sp."spaceId"
  JOIN "bots" bot ON bot.id = sp."botId" AND bot."archivedAt" IS NULL
  WHERE sp."status" IN ('open', 'parked')
    AND trim(sp.title) <> ''
    AND NOT EXISTS (
      SELECT 1 FROM "tickets" t
      WHERE t."boardId" = b.id
        AND t."status" NOT IN ('done', 'closed')
        AND (t."assigneeBotId" = sp."botId" OR sp."botId" = ANY(t."workerBotIds"))
        AND lower(trim(t.title)) = lower(LEFT(trim(sp.title), 200))
    )
)
INSERT INTO "tickets" (
  "id",
  "boardId",
  "spaceId",
  "number",
  "title",
  "description",
  "status",
  "priority",
  "assigneeBotId",
  "ownerUserId",
  "ownerBotId",
  "workerBotIds",
  "createdByBotId",
  "createdByUserId",
  "createdAt",
  "updatedAt"
)
SELECT
  'tkt_' || substr(md5(m.scratchpad_id || ':ticket'), 1, 20),
  m.board_id,
  m."spaceId",
  m.ticket_number,
  m.title,
  m.description,
  m.status,
  'normal',
  m."botId",
  NULL,
  m."botId",
  ARRAY[m."botId"],
  m."botId",
  m.creator_user_id,
  m."createdAt",
  m."updatedAt"
FROM to_migrate m
ON CONFLICT ("boardId", "number") DO NOTHING;

-- Advance each board's ticket counter past all migrated tickets.
UPDATE "boards" b
SET "nextNumber" = GREATEST(
  b."nextNumber",
  COALESCE((SELECT MAX(t.number) + 1 FROM "tickets" t WHERE t."boardId" = b.id), 1)
),
"updatedAt" = NOW();

-- Retire migrated open/parked scratchpad items by marking them done.
UPDATE "scratchpad_items"
SET "status" = 'done', "updatedAt" = NOW()
WHERE "status" IN ('open', 'parked');
