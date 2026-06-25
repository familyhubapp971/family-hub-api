-- Rollback for 0036_learn_accuracy_tracking.sql (FHS-401). Manual-only.
ALTER TABLE "mw_logic_progress" DROP COLUMN IF EXISTS "total_attempts";
ALTER TABLE "mw_maths_progress" DROP COLUMN IF EXISTS "total_correct";
ALTER TABLE "mw_maths_progress" DROP COLUMN IF EXISTS "total_attempts";
