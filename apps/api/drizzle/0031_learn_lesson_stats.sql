-- FHS-283 — interactive Learn lessons. Add per-(member,subject) lesson stats to
-- learn_progress so streak/best/score persist and a certificate can be awarded.
ALTER TABLE "learn_progress" ADD COLUMN IF NOT EXISTS "current_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "learn_progress" ADD COLUMN IF NOT EXISTS "best_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "learn_progress" ADD COLUMN IF NOT EXISTS "total_correct" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "learn_progress" ADD COLUMN IF NOT EXISTS "total_answered" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "learn_progress" ADD COLUMN IF NOT EXISTS "certificate_at" timestamp with time zone;
