-- FHS-510 — boot-applied copy of the member_email_changes RLS from
-- 0043_member_email_changes.sql.
--
-- Why this file exists: `drizzle-kit push --force` creates the table (it's in
-- schema.ts) but knows NOTHING about RLS — so the table would boot WITHOUT its
-- tenant-isolation policy, leaving a tenant-scoped table unprotected. This
-- re-applies ENABLE/FORCE RLS + the tenant_isolation policy on every deploy,
-- alongside 0028's tenant policies in apply-rls.mjs (gated by APPLY_RLS, run as
-- the owner/migrate role). Depends on app_current_tenant() (0028), so it is
-- applied AFTER the 0027/0028/0029 files in the apply-rls.mjs FILES list.
--
-- Every statement is idempotent (ENABLE/FORCE no-ops, DROP POLICY IF EXISTS +
-- CREATE). Keep in sync with the RLS block in 0043_member_email_changes.sql.

ALTER TABLE "member_email_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "member_email_changes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "member_email_changes";
CREATE POLICY tenant_isolation ON "member_email_changes"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
