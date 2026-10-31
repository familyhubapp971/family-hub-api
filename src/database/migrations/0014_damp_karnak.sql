CREATE TYPE "public"."event_type" AS ENUM('school', 'home');--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "type" "event_type" DEFAULT 'home' NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "wear" text;