-- Rollback for 0045_get_started_state.sql (FHS-634). Manual-only.
-- Dropping these puts the guide back to browser-local state: every parent is
-- shown it again once, on every device.
ALTER TABLE "members" DROP COLUMN IF EXISTS "get_started_dismissed_at";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "sticker_rate_set_at";
