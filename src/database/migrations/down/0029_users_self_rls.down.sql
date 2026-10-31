-- Rollback for 0029_users_self_rls. Manual-only.
DROP POLICY IF EXISTS user_self_isolation ON "users";
ALTER TABLE "users" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "users" DISABLE ROW LEVEL SECURITY;
DROP FUNCTION IF EXISTS app_current_user();
