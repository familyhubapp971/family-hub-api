-- FHS-347 — Non-BYPASSRLS application login role for RLS enforcement.
--
-- The running app will connect as app_runtime (FHS-351) so Postgres can
-- police it with the RLS policies added in FHS-348/349. Migrations + DDL stay
-- on the owner/superuser role — this migration itself runs as the owner.
-- Idempotent: roles are cluster-global, and the integration test DB drops +
-- recreates the public schema each run but never the role.
--
-- No password lives here — secrets never go in committed SQL. The integration
-- test sets a throwaway password after migrating; staging sets it out of band
-- (FHS-351 runbook) before DATABASE_URL is flipped to app_runtime.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN;
  END IF;
END
$$;--> statement-breakpoint

-- Re-assert the attributes every run (also corrects a pre-existing role): a
-- plain login Postgres' RLS actually applies to — never a bypass, never a
-- superuser, no DDL rights.
ALTER ROLE app_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS LOGIN;--> statement-breakpoint

-- Stop *every* role from creating objects in public. This is the PG16 default
-- (and a no-op on Supabase/PG16, where PUBLIC already lacks CREATE), but the
-- integration harness re-grants ALL to PUBLIC — undo that so app_runtime (a
-- member of PUBLIC) can never run DDL. On a pre-PG15 / self-hosted DB this also
-- removes the old PUBLIC-can-CREATE default — intended hardening. The owner
-- still owns the schema and can create freely, so migrations are unaffected.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_runtime;--> statement-breakpoint

-- Exactly CRUD on the existing tables + sequence USAGE. Nothing more — no
-- TRUNCATE, REFERENCES, TRIGGER, or DDL.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;--> statement-breakpoint
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_runtime;--> statement-breakpoint

-- Same grants for tables/sequences the owner creates in future migrations, so
-- app_runtime keeps working without a re-grant each time.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO app_runtime;
