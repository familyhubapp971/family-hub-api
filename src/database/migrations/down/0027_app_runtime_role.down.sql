-- Rollback for 0027_app_runtime_role. Manual-only (nothing auto-runs down/).
-- Guarded so a second rollback (role already gone) is a clean no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM app_runtime;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE USAGE ON SEQUENCES FROM app_runtime;
    DROP OWNED BY app_runtime;
    DROP ROLE app_runtime;
  END IF;
END
$$;
-- NB: CREATE on schema public is left revoked from PUBLIC (PG16 default).
