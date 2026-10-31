-- FHS-354 — SECURITY DEFINER readers for legitimately cross-tenant / pre-tenant
-- lookups that RLS would block once the app runs as app_runtime (the limited
-- role can't see across tenants). Each is owned by the migrate/owner role
-- (which bypasses RLS), is a single tightly-scoped lookup keyed on a NON-tenant
-- boundary (the user's id / the invite email), and pins SET search_path = public
-- so it can't be hijacked. EXECUTE is revoked from PUBLIC and granted only to
-- app_runtime.

-- All of a user's memberships across families — for GET /api/me. The user id is
-- the access boundary; returns only that user's rows.
CREATE OR REPLACE FUNCTION app_user_memberships(p_user_id uuid)
RETURNS TABLE (tenant_id uuid, slug text, name text, onboarding_completed boolean, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT t.id, t.slug, t.name, t.onboarding_completed, m.role::text
  FROM members m
  JOIN tenants t ON t.id = m.tenant_id
  WHERE m.user_id = p_user_id
$fn$;--> statement-breakpoint

-- Pending invitations addressed to an email, across families — for the invite
-- claim flow (the claimer has no membership in those tenants yet). The email is
-- the access boundary.
CREATE OR REPLACE FUNCTION app_claimable_invitations(p_email text)
RETURNS TABLE (id uuid, tenant_id uuid, member_id uuid, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT id, tenant_id, member_id, role::text
  FROM pending_invitations
  WHERE status = 'pending' AND lower(email) = lower(p_email)
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_user_memberships(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_claimable_invitations(text) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION app_user_memberships(uuid) TO app_runtime;
    GRANT EXECUTE ON FUNCTION app_claimable_invitations(text) TO app_runtime;
  END IF;
END
$$;
