-- Rollback for 0033_mw_investments_deductible.sql (FHS-378). Manual-only.
ALTER TABLE "mw_investments" DROP COLUMN IF EXISTS "deductible";
