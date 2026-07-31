-- Rollback for 0042_reward_config.sql (FHS-512). Manual-only.
-- NOTE: dropping money_adjustments loses the penalty audit trail; the
-- amounts already folded into mw_savings.saved_cash are NOT reversed by
-- this rollback (that would require re-deriving history). Only run this if
-- the feature is being fully reverted before any family has used it.
DROP TABLE IF EXISTS "money_adjustments";
ALTER TABLE "habits" DROP COLUMN IF EXISTS "skip_penalty_minor";
ALTER TABLE "habits" DROP COLUMN IF EXISTS "boost";
ALTER TABLE "members" DROP COLUMN IF EXISTS "sticker_rate_minor";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "sticker_rate_minor";
