-- Rollback for 0046_screen_feedback.sql (FHS-670). Manual-only.
-- Dropping these loses which screen each per-screen answer was about.
ALTER TABLE "beta_feedback" DROP COLUMN IF EXISTS "screen";
ALTER TABLE "beta_feedback" DROP COLUMN IF EXISTS "features";
ALTER TABLE "beta_feedback" DROP COLUMN IF EXISTS "visit_id";
