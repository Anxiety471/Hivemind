-- Additive: older releases neither read nor write it.
ALTER TABLE "routines" ADD COLUMN "prepare" JSONB;
