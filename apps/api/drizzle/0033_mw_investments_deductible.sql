-- FHS-378 — deductible vs non-deductible My World investments.
--
-- Adds mw_investments.deductible. When true (the default, matching the legacy
-- behaviour) a missed day applies the −2/day penalty; when false the investment
-- still counts/shows missed days but loses no value for them. Additive +
-- idempotent so existing rows keep current behaviour.
--
-- Rollback: drizzle/down/0033_mw_investments_deductible.down.sql.

ALTER TABLE "mw_investments" ADD COLUMN IF NOT EXISTS "deductible" boolean NOT NULL DEFAULT true;
