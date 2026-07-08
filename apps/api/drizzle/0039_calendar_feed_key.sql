-- FHS-445 — calendar sync (subscribe link).
--
-- Adds one nullable column to `tenants`: the per-family secret that signs the
-- calendar "subscribe link" token (HMAC). Null until the family first opens the
-- sync card; rotating it regenerates the value and invalidates every existing
-- subscription. The value never leaves the server (it is never returned by any
-- endpoint — only the signed token derived from it is).
--
-- No new table, no RLS change: `tenants` is the root table and is not
-- RLS-scoped, so the public feed endpoint can read a family's key by id after
-- pinning the (signature-verified) tenant.
--
-- Rollback: drizzle/down/0039_calendar_feed_key.down.sql

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "calendar_feed_key" text;
