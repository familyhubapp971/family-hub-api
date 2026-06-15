-- Rollback for 0024_worthless_arachne.sql (Learn Phase 1 — reading_log table).

-- Drop index first, then constraints, then table.
DROP INDEX IF EXISTS "reading_log_tenant_member_created_idx";
ALTER TABLE IF EXISTS "reading_log" DROP CONSTRAINT IF EXISTS "reading_log_member_id_members_id_fk";
ALTER TABLE IF EXISTS "reading_log" DROP CONSTRAINT IF EXISTS "reading_log_tenant_id_tenants_id_fk";
DROP TABLE IF EXISTS "reading_log";
