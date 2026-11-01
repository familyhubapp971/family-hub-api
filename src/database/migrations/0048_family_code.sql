-- FHS-715 / FHS-716: a family's private code and its creator.
--
-- previous_slug keeps a family's old surname address after it moves to a
-- private code (e29b-41d4), so old links still reach the family for its own
-- signed-in members. created_by records who created the family: one family
-- per home. Both are nullable; scripts/server/give-families-codes.sql fills
-- them for existing families.
--
-- Staging and production get these from drizzle-kit push on boot; this file
-- builds the test database.
--
-- Rollback: down/0048_family_code.down.sql.

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "previous_slug" varchar(63);--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "created_by" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_previous_slug_unique" ON "tenants" USING btree ("previous_slug");
