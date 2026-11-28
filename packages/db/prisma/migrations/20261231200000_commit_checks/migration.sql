-- Additive: older releases never read or write these tables, so they keep working through the deploy.
CREATE TABLE "commit_checks" (
    "spaceId" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "checkRunId" BIGINT NOT NULL,
    "state" TEXT NOT NULL,
    "url" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "commit_checks_pkey" PRIMARY KEY ("spaceId", "repository", "headSha", "name")
);

ALTER TABLE "commit_checks" ADD CONSTRAINT "commit_checks_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "commit_checks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY commit_checks_tenant ON "commit_checks"
    USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY commit_checks_system ON "commit_checks"
    USING ((SELECT app_rls_bypass()));

CREATE TABLE "pull_request_heads" (
    "spaceId" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pull_request_heads_pkey" PRIMARY KEY ("spaceId", "repository", "number")
);

ALTER TABLE "pull_request_heads" ADD CONSTRAINT "pull_request_heads_spaceId_fkey"
    FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pull_request_heads" ENABLE ROW LEVEL SECURITY;
CREATE POLICY pull_request_heads_tenant ON "pull_request_heads"
    USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY pull_request_heads_system ON "pull_request_heads"
    USING ((SELECT app_rls_bypass()));
