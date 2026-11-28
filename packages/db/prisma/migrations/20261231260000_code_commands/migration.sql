-- Additive: scripts bots save and call as codemode.cmd.<name>. Older releases never read or write
-- this table. One namespace for the deployment, so no row-level security (see the model).
CREATE TABLE "code_commands" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon" TEXT,
    "parameters" JSONB,
    "code" TEXT NOT NULL,
    "updatedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_commands_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "code_commands_name_key" ON "code_commands"("name");
