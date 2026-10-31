-- Rollback FHS-476 — drop the recurring-activity columns.
ALTER TABLE "events" DROP COLUMN IF EXISTS "recurrence_end_date";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN IF EXISTS "recurrence_days";
