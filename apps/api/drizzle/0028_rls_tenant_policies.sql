-- FHS-348 — Enable Row-Level Security + deny-by-default tenant policies on every
-- tenant-scoped table. The database itself now refuses to return another
-- family's rows even if an app query forgets its tenant_id filter.
--
-- The per-request tenant lives in the GUC app.current_tenant (set by the
-- request middleware, FHS-346). app_current_tenant() reads it and ALWAYS fails
-- closed: unset, the empty sentinel, OR a malformed non-uuid value all map to
-- NULL (the regex gate means a bad value never reaches the ::uuid cast, so the
-- policy can never raise instead of denying). NULL fails every comparison →
-- zero rows / rejected writes.
--
-- ENABLE makes RLS apply to non-owner roles (app_runtime, FHS-347); FORCE makes
-- it apply to the table owner too. Superusers + BYPASSRLS roles still bypass
-- (migrations, the test superuser) — intended. Idempotent: ENABLE/FORCE are
-- no-ops if already set; CREATE OR REPLACE FUNCTION and DROP POLICY IF EXISTS +
-- CREATE re-apply cleanly. App-level WHERE tenant_id = ... filters STAY as
-- defence-in-depth (ADR 0016).
--
-- NB: staging boots via drizzle-kit push --force (schema.ts diff), which does
-- NOT run this file. RLS reaches staging only when FHS-351 wires an explicit
-- apply step into boot, just before flipping DATABASE_URL to app_runtime.

-- Safe reader for the per-request tenant GUC. STABLE + pure SQL so the planner
-- can inline it; the regex gate guarantees the ::uuid cast never errors, so the
-- function returns NULL (fail closed) for anything that isn't a real uuid.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $fn$
  SELECT CASE
    WHEN current_setting('app.current_tenant', true)
         ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN current_setting('app.current_tenant', true)::uuid
    ELSE NULL
  END
$fn$;
--> statement-breakpoint
ALTER TABLE "activity_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activity_logs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "activity_logs";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "activity_logs"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "app_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "app_settings";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "app_settings"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assignments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "assignments";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "assignments"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "events";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "events"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "habit_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "habit_logs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "habit_logs";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "habit_logs"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "habit_stickers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "habit_stickers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "habit_stickers";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "habit_stickers"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "habits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "habits" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "habits";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "habits"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "investments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "investments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "investments";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "investments"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "journal_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "journal_entries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "journal_entries";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "journal_entries"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "learn_progress" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "learn_progress" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "learn_progress";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "learn_progress"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "meal_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "meal_templates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "meal_templates";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "meal_templates"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "members" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "members";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "members"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "mw_investments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mw_investments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "mw_investments";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mw_investments"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "mw_savings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mw_savings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "mw_savings";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mw_savings"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "mw_savings_transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mw_savings_transactions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "mw_savings_transactions";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mw_savings_transactions"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "mw_week_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mw_week_actions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "mw_week_actions";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mw_week_actions"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "mw_weeks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mw_weeks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "mw_weeks";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "mw_weeks"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "notices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "notices";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "notices"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "pending_invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pending_invitations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "pending_invitations";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "pending_invitations"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "reading_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reading_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "reading_log";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "reading_log"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "reward_redemptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reward_redemptions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "reward_redemptions";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "reward_redemptions"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "rewards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rewards" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "rewards";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "rewards"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "savings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "savings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "savings";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "savings"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "savings_transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "savings_transactions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "savings_transactions";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "savings_transactions"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tasks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "tasks";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "tasks"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "week_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "week_actions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "week_actions";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "week_actions"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "weeks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "weeks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "weeks";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "weeks"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "world_flags_learn_progress" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "world_flags_learn_progress" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "world_flags_learn_progress";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "world_flags_learn_progress"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint
ALTER TABLE "world_flags_progress" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "world_flags_progress" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "world_flags_progress";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "world_flags_progress"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
