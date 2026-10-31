CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);

-- RLS for the users mirror table.
--
-- Per ADR 0001, every table has RLS enabled even when it isn't
-- tenant-scoped. Users are the one global table — a user can belong to
-- multiple tenants — so there is no `tenant_id` predicate. Instead:
--
--   1. Authenticated users can SELECT only their own row, keyed off the
--      JWT `sub` claim that PostgREST/Supabase exposes via the GUC
--      `request.jwt.claim.sub`.
--   2. The Supabase-managed `service_role` bypasses via a permissive
--      policy — used by the api's `getOrCreateUser()` upsert on first
--      authenticated request, and by background admin tooling.
--
-- The role grant is wrapped in a DO block so the migration is idempotent
-- on plain-Postgres test instances (e.g. docker-compose.test.yml) where
-- the Supabase `service_role` doesn't exist. There the role-bound policy
-- is skipped; tests run as the DB owner and don't hit RLS.

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_self_read" ON "users"
  FOR SELECT
  USING (id = (current_setting('request.jwt.claim.sub', true))::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'CREATE POLICY "users_service_role_all" ON "users" FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END
$$;
