-- FHS-634 — move the dashboard "Getting started" guide off the browser.
--
-- Two additive, nullable columns; no new table, so the existing tenant_isolation
-- policies on members and tenants already cover both.
--
--   members.get_started_dismissed_at
--     When this person hid the guide. It used to live in localStorage, so a
--     parent who dismissed it met it again on their next browser.
--
--   tenants.sticker_rate_set_at
--     When an admin chose what a sticker is worth. sticker_rate_minor is
--     NOT NULL DEFAULT 50, so its value cannot say whether anyone ever picked
--     it; this timestamp can. Left NULL for existing families on purpose: the
--     guide asks them once, and PUT /api/reward-config stamps it thereafter.
--
-- Rollback: drizzle/down/0045_get_started_state.down.sql.

ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "get_started_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "sticker_rate_set_at" timestamp with time zone;
