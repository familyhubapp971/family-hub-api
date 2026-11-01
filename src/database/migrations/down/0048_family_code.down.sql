-- Rollback for 0048_family_code.sql (FHS-715 / FHS-716). Manual-only.
-- Run only after moving families back to their old addresses
-- (UPDATE tenants SET slug = previous_slug WHERE previous_slug IS NOT NULL),
-- or old links and kid codes stop working.
--
-- NEVER redeploy an api older than FHS-715 after the backfill has run: its
-- boot-time push would drop these columns, and with them every family's old
-- address. If that ever happens, restore from fhs715_backup.tenant_addresses
-- (made by scripts/server/give-families-codes.sql).
DROP INDEX IF EXISTS "tenants_previous_slug_unique";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "created_by";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "previous_slug";
