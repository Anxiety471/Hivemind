-- Additive: the memory roamer keeps the text a skill had before it upgraded it.
-- Older releases never read or write this table.
CREATE TABLE "agent_skill_revisions" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_skill_revisions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_skill_revisions_skillId_createdAt_idx"
    ON "agent_skill_revisions"("skillId", "createdAt");

ALTER TABLE "agent_skill_revisions" ADD CONSTRAINT "agent_skill_revisions_skillId_fkey"
    FOREIGN KEY ("skillId") REFERENCES "agent_skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_skill_revisions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_skill_revisions_tenant ON "agent_skill_revisions"
    USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY agent_skill_revisions_system ON "agent_skill_revisions"
    USING ((SELECT app_rls_bypass()));
