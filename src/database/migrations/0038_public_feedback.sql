-- FHS-429 — Anonymous public feedback storage.
--
-- New table `public_feedback` captures survey responses from logged-out visitors
-- on the public homepage. Unlike `beta_feedback` this table has NO tenant_id —
-- anonymous visitors have no family account.
--
-- RLS is deliberately NOT enabled on this table:
--   - There are no per-row access boundaries to enforce (all rows are public
--     submissions; no visitor can read them through the API anyway).
--   - app_runtime already has INSERT on every new table via the DEFAULT PRIVILEGES
--     grant in migration 0027 (ALTER DEFAULT PRIVILEGES IN SCHEMA public …).
--   - Enabling RLS without a policy on a non-tenant table would silently deny all
--     writes from app_runtime (RLS fails closed by default) — the wrong outcome.
--
-- Rollback: drizzle/down/0038_public_feedback.down.sql

CREATE TABLE "public_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text,
  "email" text,
  "pmf_disappointment" text,
  "recommend_score" integer,
  "solves_problem" integer,
  "ease_of_use" integer,
  "keep_using" integer,
  "pain_point" text,
  "feature_request" text,
  "other_feedback" text,
  "source" text NOT NULL DEFAULT 'public',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "public_feedback_pmf_disappointment_check"
    CHECK ("pmf_disappointment" IS NULL OR "pmf_disappointment" IN ('very', 'somewhat', 'not')),
  CONSTRAINT "public_feedback_recommend_score_check"
    CHECK ("recommend_score" IS NULL OR ("recommend_score" >= 0 AND "recommend_score" <= 10)),
  CONSTRAINT "public_feedback_solves_problem_check"
    CHECK ("solves_problem" IS NULL OR ("solves_problem" >= 1 AND "solves_problem" <= 5)),
  CONSTRAINT "public_feedback_ease_of_use_check"
    CHECK ("ease_of_use" IS NULL OR ("ease_of_use" >= 1 AND "ease_of_use" <= 5)),
  CONSTRAINT "public_feedback_keep_using_check"
    CHECK ("keep_using" IS NULL OR ("keep_using" >= 1 AND "keep_using" <= 5)),
  CONSTRAINT "public_feedback_name_length_check"
    CHECK ("name" IS NULL OR length("name") <= 120),
  CONSTRAINT "public_feedback_email_length_check"
    CHECK ("email" IS NULL OR length("email") <= 200)
);
--> statement-breakpoint
CREATE INDEX "public_feedback_created_idx" ON "public_feedback" ("created_at");
--> statement-breakpoint
-- Explicit grant: belt-and-suspenders on top of the DEFAULT PRIVILEGES in 0027,
-- in case this migration runs before the DEFAULT PRIVILEGES clause takes effect
-- in a fresh DB (e.g. a pg_restore that skips 0027's ALTER DEFAULT PRIVILEGES).
-- Idempotent — GRANT is safe to repeat.
GRANT SELECT, INSERT ON "public_feedback" TO app_runtime;
