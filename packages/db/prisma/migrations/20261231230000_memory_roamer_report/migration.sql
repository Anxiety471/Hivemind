-- Additive: the last pass's per-bot outcomes and changes are stored with its settings row.
ALTER TABLE "memory_roamer_settings"
    ADD COLUMN "lastReport" JSONB;
