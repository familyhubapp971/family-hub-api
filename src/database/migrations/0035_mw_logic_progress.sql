-- FHS-395 — Logic progression tables for the kid ChildWorld screen.
--
-- Ported from the legacy family-hub logic_certificates table, extended with
-- a per-answer progress counter so the server can award certificates
-- server-authoritatively (no client POST required). Upgraded to the multi-tenant,
-- RLS-guarded, UUID-PK pattern used by every other mw_* table.
--
-- Tables:
--   mw_logic_progress     — per-kid correct-answer count for each game_type × difficulty.
--   mw_logic_certificates — per-kid achievement certs (game_type × difficulty, idempotent).
--
-- Rollback: drizzle/down/0035_mw_logic_progress.down.sql.

-- ─── mw_logic_progress ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "mw_logic_progress" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"     uuid NOT NULL,
  "member_id"     uuid NOT NULL,
  "game_type"     text NOT NULL,
  "difficulty"    text NOT NULL,
  "correct_count" integer NOT NULL DEFAULT 0,
  "updated_at"    timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "mw_logic_progress"
  ADD CONSTRAINT "mw_logic_progress_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mw_logic_progress"
  ADD CONSTRAINT "mw_logic_progress_member_id_members_id_fk"
  FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mw_logic_progress_unique_idx"
  ON "mw_logic_progress" USING btree ("tenant_id","member_id","game_type","difficulty");
--> statement-breakpoint
CREATE INDEX "mw_logic_progress_member_idx"
  ON "mw_logic_progress" USING btree ("tenant_id","member_id");
--> statement-breakpoint
ALTER TABLE "mw_logic_progress" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mw_logic_progress" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "mw_logic_progress";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mw_logic_progress"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- ─── mw_logic_certificates ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "mw_logic_certificates" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"     uuid NOT NULL,
  "member_id"     uuid NOT NULL,
  "game_type"     text NOT NULL,
  "difficulty"    text NOT NULL,
  "total_correct" integer NOT NULL,
  "earned_at"     timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "mw_logic_certificates"
  ADD CONSTRAINT "mw_logic_certificates_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mw_logic_certificates"
  ADD CONSTRAINT "mw_logic_certificates_member_id_members_id_fk"
  FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mw_logic_certificates_unique_idx"
  ON "mw_logic_certificates" USING btree ("tenant_id","member_id","game_type","difficulty");
--> statement-breakpoint
CREATE INDEX "mw_logic_certificates_member_idx"
  ON "mw_logic_certificates" USING btree ("tenant_id","member_id");
--> statement-breakpoint
ALTER TABLE "mw_logic_certificates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "mw_logic_certificates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "mw_logic_certificates";
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mw_logic_certificates"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
