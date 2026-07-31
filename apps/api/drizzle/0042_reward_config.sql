-- FHS-512 — configurable reward economy: sticker rate, habit boost, skip
-- penalty, and the money_adjustments ledger.
--
-- Money rule: every new column here is an INTEGER in minor currency units
-- (e.g. 50 = 0.50) — never a float. `effectiveRateMinor` in
-- apps/api/src/lib/reward-config.ts resolves the family default vs a
-- child's own override.
--
-- Rollback: drizzle/down/0042_reward_config.down.sql.

-- tenants.sticker_rate_minor — family default "1 sticker is worth" rate.
-- Backfilled to 50 (the old hardcoded 0.5) so existing families see no
-- change in behaviour until they visit the new Pocket money screen.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "sticker_rate_minor" integer NOT NULL DEFAULT 50;--> statement-breakpoint

-- members.sticker_rate_minor — optional per-child override; null = use the
-- family default above.
ALTER TABLE "members" ADD COLUMN IF NOT EXISTS "sticker_rate_minor" integer;--> statement-breakpoint

-- habits.boost — generalises is_bonus (1 = normal, 2/3/5 = boosted). Existing
-- bonus habits keep earning 5 (their previous fixed bonus value).
ALTER TABLE "habits" ADD COLUMN IF NOT EXISTS "boost" integer NOT NULL DEFAULT 1;--> statement-breakpoint
UPDATE "habits" SET "boost" = 5 WHERE "is_bonus" = true AND "boost" = 1;--> statement-breakpoint

-- habits.skip_penalty_minor — money deducted per due day missed. 0 = none.
ALTER TABLE "habits" ADD COLUMN IF NOT EXISTS "skip_penalty_minor" integer NOT NULL DEFAULT 0;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "money_adjustments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "member_id" uuid NOT NULL,
  "habit_id" uuid,
  "day" date NOT NULL,
  "amount_minor" integer NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "money_adjustments" ADD CONSTRAINT "money_adjustments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_adjustments" ADD CONSTRAINT "money_adjustments_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_adjustments" ADD CONSTRAINT "money_adjustments_habit_id_habits_id_fk" FOREIGN KEY ("habit_id") REFERENCES "public"."habits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "money_adjustments_tenant_member_idx" ON "money_adjustments" USING btree ("tenant_id","member_id");--> statement-breakpoint

-- RLS: deny-by-default tenant isolation, same pattern as 0028_rls_tenant_policies.
ALTER TABLE "money_adjustments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "money_adjustments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "money_adjustments";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "money_adjustments"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
