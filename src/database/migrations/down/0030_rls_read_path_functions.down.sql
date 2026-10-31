-- Rollback for 0030_rls_read_path_functions. Manual-only.
DROP FUNCTION IF EXISTS app_user_memberships(uuid);
DROP FUNCTION IF EXISTS app_claimable_invitations(text);
