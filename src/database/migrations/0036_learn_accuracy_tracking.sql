-- FHS-401 — Add per-subject attempt counters so Learn Insights can show real accuracy %.
--
-- Additive ALTER TABLE ADD COLUMN only. No RLS change — same tables, same policies.
-- Existing rows default to 0 (no historical data available).
--
-- mw_logic_progress: add total_attempts (every answer incremented server-side in gradeAndRecord).
-- mw_maths_progress: add total_correct + total_attempts (accumulated from PUT body per stage).
--
-- Rollback: drizzle/down/0036_learn_accuracy_tracking.down.sql

-- ─── mw_logic_progress ────────────────────────────────────────────────────────

ALTER TABLE "mw_logic_progress"
  ADD COLUMN IF NOT EXISTS "total_attempts" integer NOT NULL DEFAULT 0;

-- ─── mw_maths_progress ───────────────────────────────────────────────────────

ALTER TABLE "mw_maths_progress"
  ADD COLUMN IF NOT EXISTS "total_correct" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "mw_maths_progress"
  ADD COLUMN IF NOT EXISTS "total_attempts" integer NOT NULL DEFAULT 0;
