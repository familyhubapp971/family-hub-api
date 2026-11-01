-- Rollback for 0048_family_code.sql (FHS-715 / FHS-716). Manual-only.
-- Run only after moving families back to their old addresses
-- (UPDATE tenants SET slug = previous_slug WHERE previous_slug IS NOT NULL),
-- or old links and kid codes stop working.
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_previous_slug_unique";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "created_by";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "previous_slug";
