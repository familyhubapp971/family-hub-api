-- FHS-670: per-screen feedback.
--
-- Three additive, nullable columns on beta_feedback. No new table, so the
-- existing tenant_isolation policy already covers them. Rows from the general
-- survey leave all three NULL.
--
--   screen    which screen the answer is about (meals, calendar, child-journal...)
--   features  the parts of that screen the parent tapped
--   visit_id  one ID per browser-tab visit, so one person's answers group together
--
-- Rollback: drizzle/down/0046_screen_feedback.down.sql.

ALTER TABLE "beta_feedback" ADD COLUMN IF NOT EXISTS "screen" text;--> statement-breakpoint
ALTER TABLE "beta_feedback" ADD COLUMN IF NOT EXISTS "features" text[];--> statement-breakpoint
ALTER TABLE "beta_feedback" ADD COLUMN IF NOT EXISTS "visit_id" uuid;
