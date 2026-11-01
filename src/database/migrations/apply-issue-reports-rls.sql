-- FHS-717: boot-applied copy of the issue report RLS from 0049_issue_reports.sql.
--
-- drizzle-kit push creates both tables from schema.ts but knows nothing about
-- RLS, so without this file they would boot with no family lock. apply-rls.mjs
-- runs it on every deploy (gated by APPLY_RLS, as the owner/migrate role),
-- after 0028 so app_current_tenant() exists.
--
-- Every statement is idempotent. Keep in sync with 0049_issue_reports.sql
-- (tests/unit/api/database/issue-reports-migration.test.ts checks it).

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
