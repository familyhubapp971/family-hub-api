-- Rollback for 0047_founder_feedback_reader.sql (FHS-672). Manual-only.
-- Also remove the file from scripts/apply-functions.mjs, or the next boot
-- recreates it. The /admin feedback page then stops loading answers.
DROP FUNCTION IF EXISTS app_founder_feedback(integer);
