-- Rollback for 0022_lean_boom_boom.sql (FHS-296).
DROP INDEX IF EXISTS "habits_tenant_member_idx";
ALTER TABLE "habits" DROP COLUMN IF EXISTS "member_id";
