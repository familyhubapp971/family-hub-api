-- Rollback for 0044_mw_investments_coefficient.sql (FHS-534). Manual-only.
ALTER TABLE "mw_investments" DROP COLUMN IF EXISTS "coefficient";
