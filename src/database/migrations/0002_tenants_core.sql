CREATE TYPE "public"."habit_cadence" AS ENUM('daily', 'weekly', 'custom');--> statement-breakpoint
CREATE TYPE "public"."investment_asset_type" AS ENUM('stock', 'etf', 'bond', 'crypto', 'real_estate', 'other');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('admin', 'adult', 'teen', 'child', 'guest');--> statement-breakpoint
CREATE TYPE "public"."savings_transaction_type" AS ENUM('deposit', 'withdrawal');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "habits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"cadence" "habit_cadence" DEFAULT 'daily' NOT NULL,
	"target_count" integer DEFAULT 1 NOT NULL,
	"color" text DEFAULT '#facc15' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"asset_type" "investment_asset_type" NOT NULL,
	"quantity" numeric(18, 6),
	"purchase_price" numeric(18, 6),
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"display_name" text NOT NULL,
	"role" "member_role" DEFAULT 'adult' NOT NULL,
	"avatar_emoji" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "savings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"target_amount" numeric(12, 2),
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "savings_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"savings_id" uuid NOT NULL,
	"member_id" uuid,
	"amount" numeric(12, 2) NOT NULL,
	"type" "savings_transaction_type" NOT NULL,
	"note" text,
	"occurred_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "week_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"week_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"habit_id" uuid NOT NULL,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "weeks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "habits" ADD CONSTRAINT "habits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investments" ADD CONSTRAINT "investments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "members" ADD CONSTRAINT "members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "members" ADD CONSTRAINT "members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "savings" ADD CONSTRAINT "savings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "savings_transactions" ADD CONSTRAINT "savings_transactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "savings_transactions" ADD CONSTRAINT "savings_transactions_savings_id_savings_id_fk" FOREIGN KEY ("savings_id") REFERENCES "public"."savings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "savings_transactions" ADD CONSTRAINT "savings_transactions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "week_actions" ADD CONSTRAINT "week_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "week_actions" ADD CONSTRAINT "week_actions_week_id_weeks_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."weeks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "week_actions" ADD CONSTRAINT "week_actions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "week_actions" ADD CONSTRAINT "week_actions_habit_id_habits_id_fk" FOREIGN KEY ("habit_id") REFERENCES "public"."habits"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "weeks" ADD CONSTRAINT "weeks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "habits_tenant_id_idx" ON "habits" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "habits_tenant_created_idx" ON "habits" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "investments_tenant_id_idx" ON "investments" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "members_tenant_id_idx" ON "members" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "savings_tenant_id_idx" ON "savings" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "savings_transactions_tenant_id_idx" ON "savings_transactions" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "savings_transactions_tenant_occurred_idx" ON "savings_transactions" USING btree ("tenant_id","occurred_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "week_actions_tenant_id_idx" ON "week_actions" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "week_actions_week_member_habit_unique" ON "week_actions" USING btree ("week_id","member_id","habit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "weeks_tenant_id_idx" ON "weeks" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "weeks_tenant_start_unique" ON "weeks" USING btree ("tenant_id","start_date");