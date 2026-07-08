-- Rollback FHS-445 — drop the per-family calendar feed key column.
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "calendar_feed_key";
