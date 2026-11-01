-- FHS-717: boot-applied copy of the founder issue readers from
-- 0049_issue_reports.sql.
--
-- Both issue tables are family-locked (FORCE RLS). The founder's /admin page
-- reads every family's reports and marks them fixed, so it goes through these
-- SECURITY DEFINER functions, the same pattern as app_founder_feedback (0047).
-- They are owned by the migrate role, which bypasses RLS. The only routes that
-- call them are guarded by the founder passcode.
--
-- apply-functions.mjs runs this on every boot, because drizzle-kit push never
-- creates functions. Every statement is idempotent. MUST run as the
-- owner/migrate role. Keep in sync with 0049_issue_reports.sql
-- (tests/unit/api/database/issue-reports-migration.test.ts checks it).

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
  -- Every new report, plus the newest p_limit fixed ones (at most 500), so a
  -- report nobody has fixed yet never drops off the founder's list.
  WITH shown AS (
    SELECT r.* FROM public.issue_reports r WHERE r.status = 'new'
    UNION ALL
    (SELECT r.* FROM public.issue_reports r
      WHERE r.status = 'fixed'
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT LEAST(GREATEST(p_limit, 1), 500))
  )
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
    FROM shown r
    JOIN public.tenants t ON t.id = r.tenant_id
    LEFT JOIN public.users u ON u.id = r.submitted_by_user_id
    LEFT JOIN public.members m ON m.id = r.submitted_by_member_id
   ORDER BY r.created_at DESC, r.id DESC
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
