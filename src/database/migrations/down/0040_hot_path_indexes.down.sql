-- Rollback FHS-461 — drop the hot-path indexes.
DROP INDEX IF EXISTS "events_tenant_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "tasks_tenant_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "tasks_tenant_member_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "habit_stickers_tenant_week_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "habit_stickers_tenant_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "mw_week_actions_tenant_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "redemption_requests_tenant_status_decided_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "redemption_requests_tenant_status_requested_idx";
