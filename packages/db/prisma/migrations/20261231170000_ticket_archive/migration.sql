-- AlterTable
ALTER TABLE "tickets" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "tickets_status_archivedAt_completedAt_idx" ON "tickets"("status", "archivedAt", "completedAt");
