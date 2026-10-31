-- FHS-510 — admin-initiated sign-in email change for a grown-up member,
-- confirmed by a one-time emailed link.
--
-- Only the SHA-256 hash of the confirm token is stored (token_hash) — the raw
-- token is never persisted or logged. A row is single-use (used_at set on
-- consumption); a new request invalidates any prior pending row for the same
-- member (see the app code in routes/members.ts).
--
-- The confirm endpoint is PUBLIC (the recipient may not be signed in) and has
-- no tenant context to pin before it knows which tenant the token belongs to
-- — app_find_email_change() is a SECURITY DEFINER reader, same pattern as
-- app_claimable_invitations() in 0030_rls_read_path_functions.sql, scoped by
-- (member_id, token_hash) rather than tenant. Once the row is found the app
-- pins that tenant (pinRequestTenant) before any RLS-scoped write.
--
-- Rollback: drizzle/down/0043_member_email_changes.down.sql.

CREATE TABLE "member_email_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "member_id" uuid NOT NULL,
  "new_email" text NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "member_email_changes" ADD CONSTRAINT "member_email_changes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_email_changes" ADD CONSTRAINT "member_email_changes_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_email_changes_tenant_member_idx" ON "member_email_changes" USING btree ("tenant_id","member_id");--> statement-breakpoint
CREATE INDEX "member_email_changes_member_token_idx" ON "member_email_changes" USING btree ("member_id","token_hash");--> statement-breakpoint
-- Cheap hardening: at most one LIVE (unconfirmed) pending change per member.
-- Belt-and-braces alongside the app's delete-then-insert "invalidate any
-- prior pending row" step — closes the race where two concurrent admin
-- requests for the same member both pass that delete and both insert.
CREATE UNIQUE INDEX "member_email_changes_member_active_uq" ON "member_email_changes" USING btree ("member_id") WHERE used_at IS NULL;--> statement-breakpoint

-- RLS: deny-by-default tenant isolation, same pattern as 0028_rls_tenant_policies.
ALTER TABLE "member_email_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "member_email_changes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "member_email_changes";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "member_email_changes"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

-- FHS-354-style SECURITY DEFINER reader — the confirm endpoint is public and
-- has no tenant pinned yet, so a plain SELECT would return zero rows under
-- RLS. Scoped to (member_id, token_hash): a caller must already hold the
-- high-entropy raw token — hashed server-side before this call, never sent
-- as a hash by the client — to get a hit, so this does not widen the access
-- boundary beyond what the emailed link already grants.
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
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_find_email_change(uuid, text) FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION app_find_email_change(uuid, text) TO app_runtime;
  END IF;
END
$$;
