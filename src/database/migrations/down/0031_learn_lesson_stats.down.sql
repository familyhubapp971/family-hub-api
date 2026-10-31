-- Rollback for 0031_learn_lesson_stats. Manual-only.
ALTER TABLE "learn_progress" DROP COLUMN IF EXISTS "current_streak";
ALTER TABLE "learn_progress" DROP COLUMN IF EXISTS "best_streak";
ALTER TABLE "learn_progress" DROP COLUMN IF EXISTS "total_correct";
ALTER TABLE "learn_progress" DROP COLUMN IF EXISTS "total_answered";
ALTER TABLE "learn_progress" DROP COLUMN IF EXISTS "certificate_at";
