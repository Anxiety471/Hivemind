-- Additive: older releases keep reading and writing artifacts without touching new columns or file_folders.
CREATE TABLE "file_folders" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "parentId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trashedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_folders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "file_folders_spaceId_parentId_idx" ON "file_folders"("spaceId", "parentId");
CREATE INDEX "file_folders_spaceId_trashedAt_idx" ON "file_folders"("spaceId", "trashedAt");

-- Unique live folder name per parent (case-insensitive) for Drive & Phase 4 path lookup.
CREATE UNIQUE INDEX "file_folders_space_parent_name_key"
    ON "file_folders" ("spaceId", COALESCE("parentId", ''), LOWER("name"))
    WHERE "trashedAt" IS NULL;

ALTER TABLE "file_folders" ADD CONSTRAINT "file_folders_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "file_folders" ADD CONSTRAINT "file_folders_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "file_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "file_folders" ENABLE ROW LEVEL SECURITY;
CREATE POLICY file_folders_tenant ON "file_folders"
    USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY file_folders_system ON "file_folders"
    USING ((SELECT app_rls_bypass()));

ALTER TABLE "artifacts" ADD COLUMN "folderId" TEXT;
ALTER TABLE "artifacts" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE "artifacts" ADD COLUMN "trashedAt" TIMESTAMP(3);
ALTER TABLE "artifacts" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_folderId_fkey"
    FOREIGN KEY ("folderId") REFERENCES "file_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "artifacts_spaceId_folderId_idx" ON "artifacts"("spaceId", "folderId");
CREATE INDEX "artifacts_spaceId_trashedAt_idx" ON "artifacts"("spaceId", "trashedAt");

CREATE INDEX "artifacts_space_folder_active_idx"
    ON "artifacts"("spaceId", "folderId")
    WHERE "trashedAt" IS NULL;

CREATE INDEX "artifacts_space_trashed_only_idx"
    ON "artifacts"("spaceId", "trashedAt")
    WHERE "trashedAt" IS NOT NULL;

CREATE INDEX "artifacts_space_updated_idx"
    ON "artifacts"("spaceId", "updatedAt" DESC, "id" DESC);
