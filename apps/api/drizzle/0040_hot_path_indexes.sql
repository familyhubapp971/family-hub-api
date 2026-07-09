-- FHS-461 — hot-path indexes for the dashboard + tasks queries.
--
-- The scalability audit (documents/technical/scalability-audit.md) found the
-- dashboard's most-run queries filter/sort on columns no existing index covers,
-- so they degrade to full-tenant scans + in-memory sorts as a family accrues
-- months of rows. These indexes match the real WHERE + ORDER BY. Plain
-- (ascending) btrees serve the `ORDER BY … DESC LIMIT n` feeds via a backward
-- index scan, so no DESC is needed.
--
-- Additive + idempotent (IF NOT EXISTS). Matches the index() definitions added
-- to schema.ts so `drizzle-kit push` on staging and this migration agree.
--
-- Rollback: drizzle/down/0040_hot_path_indexes.down.sql

CREATE INDEX IF NOT EXISTS "events_tenant_created_idx" ON "events" ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_tenant_created_idx" ON "tasks" ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_tenant_member_created_idx" ON "tasks" ("tenant_id","member_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "habit_stickers_tenant_week_idx" ON "habit_stickers" ("tenant_id","week_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "habit_stickers_tenant_created_idx" ON "habit_stickers" ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mw_week_actions_tenant_created_idx" ON "mw_week_actions" ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redemption_requests_tenant_status_decided_idx" ON "redemption_requests" ("tenant_id","status","decided_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "redemption_requests_tenant_status_requested_idx" ON "redemption_requests" ("tenant_id","status","requested_at");
