-- FHS-349 — Self-scoped Row-Level Security for the global `users` table.
--
-- users is NOT tenant-scoped (it mirrors Supabase auth.users), so it gets its
-- own policy keyed on a second GUC, app.current_user: each connection sees only
-- its own user row. app_current_user() fails closed exactly like
-- app_current_tenant() — unset, empty, or malformed all map to NULL → zero rows
-- / rejected writes, and the regex gate means the ::uuid cast can never raise.
--
-- The per-request tenant context doesn't exist yet when the user-mirror upsert
-- runs (it precedes tenant resolution), so getOrCreateUser pins app.current_user
-- transaction-locally before its INSERT ... ON CONFLICT ... RETURNING.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, ENABLE/FORCE no-ops, DROP POLICY IF
-- EXISTS + CREATE. Reaches staging only via FHS-351's boot apply step.

CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
LANGUAGE sql STABLE AS $fn$
  SELECT CASE
    WHEN current_setting('app.current_user', true)
         ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN current_setting('app.current_user', true)::uuid
    ELSE NULL
  END
$fn$;--> statement-breakpoint

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS user_self_isolation ON "users";--> statement-breakpoint
CREATE POLICY user_self_isolation ON "users"
  USING (id = app_current_user())
  WITH CHECK (id = app_current_user());
