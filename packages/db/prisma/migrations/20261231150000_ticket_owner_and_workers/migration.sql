-- AlterTable
ALTER TABLE "tickets"
ADD COLUMN "ownerUserId" TEXT,
ADD COLUMN "ownerBotId" TEXT,
ADD COLUMN "workerBotIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "tickets_spaceId_ownerUserId_idx" ON "tickets"("spaceId", "ownerUserId");

-- CreateIndex
CREATE INDEX "tickets_spaceId_ownerBotId_idx" ON "tickets"("spaceId", "ownerBotId");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_ownerBotId_fkey" FOREIGN KEY ("ownerBotId") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill existing tickets: preserve legacy assigneeBotId as worker and creator as owner.
UPDATE "tickets"
SET "workerBotIds" = ARRAY["assigneeBotId"]
WHERE "assigneeBotId" IS NOT NULL
  AND cardinality("workerBotIds") = 0;

UPDATE "tickets"
SET "ownerBotId" = "createdByBotId"
WHERE "createdByBotId" IS NOT NULL
  AND "ownerBotId" IS NULL
  AND "ownerUserId" IS NULL;

UPDATE "tickets"
SET "ownerUserId" = "createdByUserId"
WHERE "createdByBotId" IS NULL
  AND "createdByUserId" IS NOT NULL
  AND "ownerBotId" IS NULL
  AND "ownerUserId" IS NULL;
