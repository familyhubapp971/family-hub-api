-- FHS-510 — boot-applied copy of the app_find_email_change() reader from
-- 0043_member_email_changes.sql.
--
-- Why this file exists: staging/prod boot with `drizzle-kit push --force`,
-- which diffs schema.ts and knows NOTHING about functions — so it never
-- creates app_find_email_change. But the PUBLIC confirm endpoint CALLS it on
-- every email-change confirmation, so it must exist on every deploy. Same
-- arrangement as 0030's readers applied by apply-functions.mjs. The table
-- itself is created by push (it's in schema.ts); this file only (re)creates
-- the function. Every statement is idempotent (CREATE OR REPLACE, REVOKE,
-- guarded GRANT). MUST run as the owner/migrate role.
--
-- Keep in sync with the function block in 0043_member_email_changes.sql.

CREATE OR REPLACE FUNCTION app_find_email_change(p_member_id uuid, p_token_hash text)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  member_id uuid,
  new_email text,
  expires_at timestamptz,
  used_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT id, tenant_id, member_id, new_email, expires_at, used_at
  FROM member_email_changes
  WHERE member_id = p_member_id AND token_hash = p_token_hash
  ORDER BY created_at DESC
  LIMIT 1
$fn$;

REVOKE ALL ON FUNCTION app_find_email_change(uuid, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION app_find_email_change(uuid, text) TO app_runtime;
  END IF;
END
$$;
