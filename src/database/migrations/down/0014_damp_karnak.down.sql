-- Rollback for 0014_damp_karnak.sql (FHS-265).
-- Drops the events type/location/wear expansion. Data in those columns
-- is lost on rollback (they're presentation fields, not relationships).

ALTER TABLE "events" DROP COLUMN IF EXISTS "wear";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN IF EXISTS "location";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN IF EXISTS "type";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."event_type";
