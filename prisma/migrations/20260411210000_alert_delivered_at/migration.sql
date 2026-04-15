-- Add `deliveredAt` to the `alerts` table for Telegram delivery tracking.
--
-- Background: this column was originally added via `prisma db push` (the
-- repo's de-facto schema sync mechanism — see CLAUDE.md "Prisma db push
-- runs on startup to sync schema") in commit 2b2ba62. Production already
-- has the column, so this migration is the catch-up record so any future
-- environment that bootstraps via `prisma migrate deploy` (rather than
-- `db push`) ends up in the same state.
--
-- `IF NOT EXISTS` keeps it idempotent against environments where db push
-- already created the column, so applying the full migration history
-- against a "warm" database is a no-op for this row.

ALTER TABLE "alerts" ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3);
