-- Rollback for 0013_strange_marvel_apes.sql (FHS-264).
-- Undoes the meal_templates member_id + recurring expansion and restores
-- the original one-row-per-(tenant, day, slot) unique index.
--
-- WARNING: recreating "meal_templates_tenant_day_slot_uniq" fails if any
-- (tenant, day, slot) now holds more than one meal (a whole-family row
-- plus per-member rows added after FHS-264 shipped). De-duplicate those
-- slots before running this rollback on data that used the new feature.

DROP INDEX IF EXISTS "meal_templates_tenant_day_slot_member_uniq";--> statement-breakpoint
DROP INDEX IF EXISTS "meal_templates_tenant_day_slot_everyone_uniq";--> statement-breakpoint
DROP INDEX IF EXISTS "meal_templates_tenant_member_idx";--> statement-breakpoint
ALTER TABLE "meal_templates" DROP CONSTRAINT IF EXISTS "meal_templates_member_id_members_id_fk";--> statement-breakpoint
ALTER TABLE "meal_templates" DROP COLUMN IF EXISTS "recurring";--> statement-breakpoint
ALTER TABLE "meal_templates" DROP COLUMN IF EXISTS "member_id";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "meal_templates_tenant_day_slot_uniq" ON "meal_templates" USING btree ("tenant_id","day_of_week","slot");
