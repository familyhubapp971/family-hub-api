-- Rollback for 0020_parallel_tarantula.sql (FHS-291).
-- Drops the My World economy tables (in FK-dependency order) + their enums
-- and the habits.icon / habits.is_bonus columns. CASCADE clears FKs.
DROP TABLE IF EXISTS "mw_transaction_stickers" CASCADE;
DROP TABLE IF EXISTS "mw_week_actions" CASCADE;
DROP TABLE IF EXISTS "mw_investments" CASCADE;
DROP TABLE IF EXISTS "mw_savings_transactions" CASCADE;
DROP TABLE IF EXISTS "mw_savings" CASCADE;
DROP TABLE IF EXISTS "habit_stickers" CASCADE;
DROP TABLE IF EXISTS "mw_weeks" CASCADE;

DROP TYPE IF EXISTS "public"."mw_week_action_type";
DROP TYPE IF EXISTS "public"."mw_savings_tx_type";
DROP TYPE IF EXISTS "public"."sticker_type";

ALTER TABLE "habits" DROP COLUMN IF EXISTS "is_bonus";
ALTER TABLE "habits" DROP COLUMN IF EXISTS "icon";
