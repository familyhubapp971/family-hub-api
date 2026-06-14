DROP INDEX "habit_stickers_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "habit_stickers_unique" ON "habit_stickers" USING btree ("tenant_id","member_id","habit_id","week_id","day");