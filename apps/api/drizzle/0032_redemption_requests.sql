-- FHS-376 — kid reward redemption requests (kid asks, admin approves/declines).
--
-- A kid's POST /api/kid/rewards/:id/request creates a `pending` row with NO
-- deduction. An admin parent's approve deducts star_cost from the kid's banked
-- SAVINGS only and flips status to 'approved'; a decline flips it to 'declined'.
-- Tenant-scoped + RLS-guarded like every other My World table (see 0028).
--
-- Rollback: drizzle/down/0032_redemption_requests.down.sql.

CREATE TYPE "public"."redemption_request_status" AS ENUM('pending', 'approved', 'declined');--> statement-breakpoint
CREATE TABLE "redemption_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "member_id" uuid NOT NULL,
  "reward_id" uuid NOT NULL,
  "status" "redemption_request_status" DEFAULT 'pending' NOT NULL,
  "star_cost" integer NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_at" timestamp with time zone,
  "decided_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "redemption_requests" ADD CONSTRAINT "redemption_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redemption_requests" ADD CONSTRAINT "redemption_requests_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redemption_requests" ADD CONSTRAINT "redemption_requests_reward_id_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."rewards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redemption_requests" ADD CONSTRAINT "redemption_requests_decided_by_members_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "redemption_requests_tenant_status_idx" ON "redemption_requests" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "redemption_requests_tenant_member_idx" ON "redemption_requests" USING btree ("tenant_id","member_id");--> statement-breakpoint
-- RLS: deny-by-default tenant isolation, same pattern as 0028_rls_tenant_policies.
ALTER TABLE "redemption_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "redemption_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON "redemption_requests";--> statement-breakpoint
CREATE POLICY tenant_isolation ON "redemption_requests"
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
