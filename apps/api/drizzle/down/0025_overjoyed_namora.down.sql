-- Rollback for 0025_overjoyed_namora.sql (Learn Phase 2a — world_flags_progress table).

DROP INDEX IF EXISTS "world_flags_progress_unique_idx";
DROP INDEX IF EXISTS "world_flags_progress_member_idx";
ALTER TABLE IF EXISTS "world_flags_progress" DROP CONSTRAINT IF EXISTS "world_flags_progress_member_id_members_id_fk";
ALTER TABLE IF EXISTS "world_flags_progress" DROP CONSTRAINT IF EXISTS "world_flags_progress_tenant_id_tenants_id_fk";
DROP TABLE IF EXISTS "world_flags_progress";
