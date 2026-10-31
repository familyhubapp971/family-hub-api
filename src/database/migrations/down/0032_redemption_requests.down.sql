-- Rollback for 0032_redemption_requests.sql (FHS-376).
-- Drops the table (which removes its RLS policy + indexes + FK constraints)
-- then the enum it depended on. CASCADE not needed: nothing references this
-- table or enum.

DROP TABLE IF EXISTS "redemption_requests";
DROP TYPE IF EXISTS "public"."redemption_request_status";
