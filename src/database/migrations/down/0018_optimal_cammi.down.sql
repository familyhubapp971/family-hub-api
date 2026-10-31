-- Rollback for 0018_optimal_cammi.sql (FHS-268).
-- Drops the kid sticker-economy ledger tables. CASCADE clears the FKs +
-- indexes with them.
DROP TABLE IF EXISTS "reward_redemptions" CASCADE;
DROP TABLE IF EXISTS "habit_logs" CASCADE;
