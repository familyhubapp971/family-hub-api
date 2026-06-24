-- FHS-394 — Maths progression tables for the kid ChildWorld screen.
--
-- Ported from the legacy family-hub maths_progress + maths_certificates tables,
-- upgraded to the multi-tenant, RLS-guarded, UUID-PK pattern used by every
-- other mw_* table in this schema. Kid-scoped: all reads/writes go through
-- /api/kid/maths/* (token carries tenantId + memberId, no URL params).
--
-- Tables:
--   mw_maths_progress   — per-kid stage completion for each operation × table.
--   mw_maths_certificates — per-kid achievement certs (op × difficulty, idempotent).
--
-- Rollback: drizzle/down/0034_mw_maths_progress.down.sql.

-- ─── mw_maths_progress ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "mw_maths_progress" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"           uuid NOT NULL,
  "member_id"           uuid NOT NULL,
  "operation"           text NOT NULL,
  "table_number"        integer NOT NULL,
  "learn_completed"     boolean NOT NULL DEFAULT false,
  "practice_correct"    integer NOT NULL DEFAULT 0,
  "prove_score"         integer NOT NULL DEFAULT 0,
  "prove_avg_time"      real NOT NULL DEFAULT 0,
  "placement_unlocked"  boolean NOT NULL DEFAULT false,
  "updated_at"          timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "mw_maths_progress"
  ADD CONSTRAINT "mw_maths_progress_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mw_maths_progress"
  ADD CONSTRAINT "mw_maths_progress_member_id_members_id_fk"
  FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mw_maths_progress_unique_idx"
  ON "mw_maths_progress" USING btree ("tenant_id","member_id","operation","table_number");
--> statement-breakpoint
CREATE INDEX "mw_maths_progress_member_idx"
  ON "mw_maths_progress" USING btree ("tenant_id","member_id");
--> statement-breakpoint
ALTER TABLE "mw_maths_progress" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mw_maths_progress" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "mw_maths_progress";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mw_maths_progress"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- ─── mw_maths_certificates ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "mw_maths_certificates" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"     uuid NOT NULL,
  "member_id"     uuid NOT NULL,
  "operation"     text NOT NULL,
  "difficulty"    text NOT NULL,
  "total_correct" integer NOT NULL,
  "earned_at"     timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "mw_maths_certificates"
  ADD CONSTRAINT "mw_maths_certificates_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mw_maths_certificates"
  ADD CONSTRAINT "mw_maths_certificates_member_id_members_id_fk"
  FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mw_maths_certificates_unique_idx"
  ON "mw_maths_certificates" USING btree ("tenant_id","member_id","operation","difficulty");
--> statement-breakpoint
CREATE INDEX "mw_maths_certificates_member_idx"
  ON "mw_maths_certificates" USING btree ("tenant_id","member_id");
--> statement-breakpoint
ALTER TABLE "mw_maths_certificates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mw_maths_certificates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "mw_maths_certificates";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mw_maths_certificates"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
