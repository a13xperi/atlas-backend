-- Safe, idempotent SQL for production rollout of AlertCategory and
-- BriefingPreference. This preserves existing rows and backfills legacy
-- NULL arrays that Prisma's schema diff does not repair.

DO $$
BEGIN
  CREATE TYPE "AlertCategory" AS ENUM ('SIGNAL', 'NOTIFICATION');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "alerts"
  ADD COLUMN IF NOT EXISTS "category" "AlertCategory";

UPDATE "alerts"
SET "category" = 'SIGNAL'
WHERE "category" IS NULL;

ALTER TABLE "alerts"
  ALTER COLUMN "category" SET DEFAULT 'SIGNAL',
  ALTER COLUMN "category" SET NOT NULL;

CREATE TABLE IF NOT EXISTS "briefing_preferences" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "deliveryTime" TEXT NOT NULL DEFAULT '08:00',
  "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "sources" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "channel" TEXT NOT NULL DEFAULT 'PORTAL',
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "briefing_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "briefing_preferences_userId_key"
ON "briefing_preferences"("userId");

DO $$
BEGIN
  ALTER TABLE "briefing_preferences"
    ADD CONSTRAINT "briefing_preferences_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "briefing_preferences"
  ALTER COLUMN "deliveryTime" SET DEFAULT '08:00',
  ALTER COLUMN "topics" SET DEFAULT ARRAY[]::TEXT[],
  ALTER COLUMN "sources" SET DEFAULT ARRAY[]::TEXT[],
  ALTER COLUMN "channel" SET DEFAULT 'PORTAL',
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

UPDATE "briefing_preferences"
SET "topics" = ARRAY[]::TEXT[]
WHERE "topics" IS NULL;

UPDATE "briefing_preferences"
SET "sources" = ARRAY[]::TEXT[]
WHERE "sources" IS NULL;
