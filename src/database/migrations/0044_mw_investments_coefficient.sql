-- FHS-534 — per-investment coefficient (parent-chosen preset 1/2/3/5).
--
-- Adds mw_investments.coefficient. It drives the investment's daily growth
-- (+coefficient per completed day, replacing the old hardcoded +5) and is
-- snapshotted at creation, so editing the habit's pay boost later never changes
-- an in-flight investment. Default 5 = the legacy fixed rate, so existing rows
-- keep their current growth. Additive + idempotent.
--
-- Rollback: drizzle/down/0044_mw_investments_coefficient.down.sql.

ALTER TABLE "mw_investments" ADD COLUMN IF NOT EXISTS "coefficient" integer NOT NULL DEFAULT 5;
