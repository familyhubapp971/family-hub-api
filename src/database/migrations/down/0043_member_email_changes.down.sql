-- Rollback for 0043_member_email_changes.sql (FHS-510). Manual-only.
-- Dropping this table loses the pending/consumed email-change audit trail;
-- any grown-up mid-flow on an unconfirmed change would need a fresh request.
DROP FUNCTION IF EXISTS app_find_email_change(uuid, text);
DROP INDEX IF EXISTS "member_email_changes_member_active_uq";
DROP TABLE IF EXISTS "member_email_changes";
