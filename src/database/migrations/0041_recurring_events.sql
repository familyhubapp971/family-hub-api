-- FHS-476 — recurring calendar activities (weekly repeat + end date).
--
-- Adds two nullable columns to `events`. `recurrence_days` holds the
-- weekdays (0=Sunday..6=Saturday) an activity repeats on as a Postgres
-- int array; null/empty means a normal one-off event. `recurrence_end_date`
-- is the last day it repeats (inclusive); null means it repeats with no
-- end. The existing `date` column keeps its meaning as the series
-- anchor (the first occurrence) — GET /api/events expands a recurring
-- row into virtual per-week occurrences on read; no new row is ever
-- written for a repeat.
--
-- Additive + nullable: no backfill needed, every existing event reads
-- as a one-off (recurrence_days is null).
--
-- Rollback: drizzle/down/0041_recurring_events.down.sql

ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "recurrence_days" integer[];--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "recurrence_end_date" date;
