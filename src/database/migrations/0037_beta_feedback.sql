-- FHS-418 — Beta feedback storage.
--
-- New table `beta_feedback` captures survey responses from authenticated users.
-- All survey columns are nullable; the API refine enforces at least one present.
-- pmf_disappointment is constrained to the 3 valid PMF values at the DB level.
--
-- Rollback: drizzle/down/0037_beta_feedback.down.sql

CREATE TABLE "beta_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "submitted_by_user_id" uuid,
  "submitted_by_email" text,
  "pmf_disappointment" text,
  "recommend_score" integer,
  "solves_problem" integer,
  "ease_of_use" integer,
  "keep_using" integer,
  "pain_point" text,
  "feature_request" text,
  "other_feedback" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "beta_feedback_pmf_disappointment_check"
    CHECK ("pmf_disappointment" IS NULL OR "pmf_disappointment" IN ('very', 'somewhat', 'not')),
  CONSTRAINT "beta_feedback_recommend_score_check"
    CHECK ("recommend_score" IS NULL OR ("recommend_score" >= 0 AND "recommend_score" <= 10)),
  CONSTRAINT "beta_feedback_solves_problem_check"
    CHECK ("solves_problem" IS NULL OR ("solves_problem" >= 1 AND "solves_problem" <= 5)),
  CONSTRAINT "beta_feedback_ease_of_use_check"
    CHECK ("ease_of_use" IS NULL OR ("ease_of_use" >= 1 AND "ease_of_use" <= 5)),
  CONSTRAINT "beta_feedback_keep_using_check"
    CHECK ("keep_using" IS NULL OR ("keep_using" >= 1 AND "keep_using" <= 5))
);
--> statement-breakpoint
ALTER TABLE "beta_feedback"
  ADD CONSTRAINT "beta_feedback_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "beta_feedback"
  ADD CONSTRAINT "beta_feedback_submitted_by_user_id_users_id_fk"
  FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "beta_feedback_tenant_id_idx" ON "beta_feedback" ("tenant_id", "id");
--> statement-breakpoint
CREATE INDEX "beta_feedback_tenant_created_idx" ON "beta_feedback" ("tenant_id", "created_at");
--> statement-breakpoint
-- RLS: same pattern as every other tenant-scoped table (ADR 0001 + FHS-348).
ALTER TABLE "beta_feedback" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "beta_feedback" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "beta_feedback";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "beta_feedback"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
