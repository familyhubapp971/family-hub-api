-- Rollback for 0049_issue_reports.sql (FHS-717). Manual-only.
-- This deletes every issue report and every photo. Back up first.
--
-- Remove the FHS-717 files from apply-functions.mjs and apply-rls.mjs, and the
-- two tables from schema.ts, in the same change: otherwise the next boot puts
-- them straight back.
DROP FUNCTION IF EXISTS app_founder_set_issue_status(uuid, text);
DROP FUNCTION IF EXISTS app_founder_issue_photo(uuid, uuid);
DROP FUNCTION IF EXISTS app_founder_issues(integer);
DROP TABLE IF EXISTS "issue_report_photos";
DROP TABLE IF EXISTS "issue_reports";
