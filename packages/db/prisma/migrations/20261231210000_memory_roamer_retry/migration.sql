-- Additive: failures and their next retry are stored with the existing settings row.
ALTER TABLE "memory_roamer_settings"
    ADD COLUMN "lastFailures" JSONB,
    ADD COLUMN "retryAt" TIMESTAMP(3),
    ADD COLUMN "retryAttempt" INTEGER NOT NULL DEFAULT 0;
