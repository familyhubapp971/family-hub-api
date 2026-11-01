-- FHS-717: grown-ups report a problem with a short description and up to 3
-- photos; the founder reads every family's reports on /admin and marks them
-- fixed.
--
--   issue_reports        one row per report (the words, the screen, new/fixed)
--   issue_report_photos  up to 3 photos per report, stored as bytes. The
--                        founder chose our own database over a storage bucket;
--                        the device shrinks each photo to 1 MB or less first.
--
-- Both tables are family-locked like beta_feedback. The founder reads and the
-- fixed/new switch go through three SECURITY DEFINER functions, like
-- app_founder_feedback (0047).
--
-- Staging and production get the tables from drizzle-kit push on boot, the
-- RLS from apply-issue-reports-rls.sql (apply-rls.mjs) and the functions from
-- apply-issue-reports-functions.sql (apply-functions.mjs). This file builds the
-- test database. Keep the three in sync.
--
-- Rollback: down/0049_issue_reports.down.sql.

CREATE TABLE "issue_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "submitted_by_user_id" uuid,
  "submitted_by_member_id" uuid,
  "screen" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "visit_id" uuid,
  "status" text DEFAULT 'new' NOT NULL,
  "fixed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "issue_reports_status_check" CHECK ("status" IN ('new', 'fixed'))
);
--> statement-breakpoint
CREATE TABLE "issue_report_photos" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "report_id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "data" bytea NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "issue_report_photos_content_type_check"
    CHECK ("content_type" IN ('image/jpeg', 'image/png', 'image/webp'))
);
--> statement-breakpoint
ALTER TABLE "issue_reports"
  ADD CONSTRAINT "issue_reports_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "issue_reports"
  ADD CONSTRAINT "issue_reports_submitted_by_user_id_users_id_fk"
  FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "issue_reports"
  ADD CONSTRAINT "issue_reports_submitted_by_member_id_members_id_fk"
  FOREIGN KEY ("submitted_by_member_id") REFERENCES "public"."members"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "issue_report_photos"
  ADD CONSTRAINT "issue_report_photos_report_id_issue_reports_id_fk"
  FOREIGN KEY ("report_id") REFERENCES "public"."issue_reports"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "issue_report_photos"
  ADD CONSTRAINT "issue_report_photos_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "issue_reports_created_idx" ON "issue_reports" USING btree ("created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "issue_reports_tenant_id_idx" ON "issue_reports" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "issue_report_photos_report_id_idx" ON "issue_report_photos" USING btree ("report_id");
--> statement-breakpoint
CREATE INDEX "issue_report_photos_tenant_id_idx" ON "issue_report_photos" USING btree ("tenant_id");
--> statement-breakpoint

-- RLS: same pattern as beta_feedback (0037) and every other family table.
ALTER TABLE "issue_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_reports" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "issue_reports";
CREATE POLICY tenant_isolation ON "issue_reports"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE "issue_report_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issue_report_photos" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "issue_report_photos";
CREATE POLICY tenant_isolation ON "issue_report_photos"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint

-- The founder's readers and the fixed/new switch (owned by the migrate role,
-- which bypasses RLS; EXECUTE only for app_runtime).
CREATE OR REPLACE FUNCTION app_founder_issues(p_limit integer)
RETURNS TABLE (
  id uuid,
  created_at timestamptz,
  screen text,
  description text,
  status text,
  fixed_at timestamptz,
  family_name text,
  reporter_email text,
  reporter_name text,
  photos jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT r.id, r.created_at, r.screen, r.description, r.status, r.fixed_at,
         t.name::text, u.email::text, m.display_name::text,
         COALESCE(
           (SELECT jsonb_agg(
                     jsonb_build_object(
                       'id', p.id, 'contentType', p.content_type, 'sizeBytes', p.size_bytes)
                     ORDER BY p.created_at, p.id)
              FROM public.issue_report_photos p
             WHERE p.report_id = r.id),
           '[]'::jsonb)
    FROM public.issue_reports r
    JOIN public.tenants t ON t.id = r.tenant_id
    LEFT JOIN public.users u ON u.id = r.submitted_by_user_id
    LEFT JOIN public.members m ON m.id = r.submitted_by_member_id
   ORDER BY r.created_at DESC, r.id DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$fn$;

CREATE OR REPLACE FUNCTION app_founder_issue_photo(p_issue uuid, p_photo uuid)
RETURNS TABLE (content_type text, size_bytes integer, data bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT p.content_type, p.size_bytes, p.data
    FROM public.issue_report_photos p
   WHERE p.id = p_photo AND p.report_id = p_issue
$fn$;

CREATE OR REPLACE FUNCTION app_founder_set_issue_status(p_issue uuid, p_status text)
RETURNS TABLE (id uuid, status text, fixed_at timestamptz)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $fn$
  UPDATE public.issue_reports r
     SET status = p_status,
         fixed_at = CASE WHEN p_status = 'fixed' THEN COALESCE(r.fixed_at, now()) ELSE NULL END
   WHERE r.id = p_issue
  RETURNING r.id, r.status, r.fixed_at
$fn$;

REVOKE ALL ON FUNCTION app_founder_issues(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_founder_issue_photo(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_founder_set_issue_status(uuid, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION app_founder_issues(integer) TO app_runtime;
    GRANT EXECUTE ON FUNCTION app_founder_issue_photo(uuid, uuid) TO app_runtime;
    GRANT EXECUTE ON FUNCTION app_founder_set_issue_status(uuid, text) TO app_runtime;
  END IF;
END
$$;
