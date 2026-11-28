-- Additive & zero-downtime: older releases continue reading/writing without setting spaceId.
ALTER TABLE "code_commands" ADD COLUMN "spaceId" TEXT;

DROP INDEX IF EXISTS "code_commands_name_key";

CREATE INDEX "code_commands_spaceId_idx" ON "code_commands"("spaceId");
CREATE UNIQUE INDEX "code_commands_spaceId_name_key" ON "code_commands"("spaceId", "name");

ALTER TABLE "code_commands" ADD CONSTRAINT "code_commands_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "code_commands" ENABLE ROW LEVEL SECURITY;
CREATE POLICY code_commands_tenant ON "code_commands"
    USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '') OR "spaceId" IS NULL);
CREATE POLICY code_commands_system ON "code_commands"
    USING ((SELECT app_rls_bypass()));
