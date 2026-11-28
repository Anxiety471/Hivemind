-- Additive: the settings row is per user; older releases ignore it.
CREATE TABLE "memory_roamer_settings" (
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 360,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastChanges" INTEGER NOT NULL DEFAULT 0,
    "lastModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_roamer_settings_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "memory_roamer_settings" ADD CONSTRAINT "memory_roamer_settings_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_roamer_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_roamer_settings_tenant ON "memory_roamer_settings"
    USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY memory_roamer_settings_system ON "memory_roamer_settings"
    USING ((SELECT app_rls_bypass()));
