-- Rollback for 0021_volatile_mister_sinister.sql (FHS-292).
-- Restore the habit_stickers unique index without member_id.
DROP INDEX IF EXISTS "habit_stickers_unique";
CREATE UNIQUE INDEX "habit_stickers_unique" ON "habit_stickers" USING btree ("tenant_id","habit_id","week_id","day");
