CREATE TYPE "public"."mw_savings_tx_type" AS ENUM('stickers', 'cash');--> statement-breakpoint
CREATE TYPE "public"."mw_week_action_type" AS ENUM('claim', 'cashout', 'save', 'invest', 'withdraw', 'auto_save', 'invest_continue');--> statement-breakpoint
CREATE TYPE "public"."sticker_type" AS ENUM('gold-star', 'heart', 'magic', 'trophy');--> statement-breakpoint
CREATE TABLE "habit_stickers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"habit_id" uuid NOT NULL,
	"week_id" uuid NOT NULL,
	"day" integer NOT NULL,
	"sticker" "sticker_type" NOT NULL,
	"sticker_value" integer DEFAULT 1 NOT NULL,
	"is_allocated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mw_investments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"habit_id" uuid NOT NULL,
	"week_id" uuid NOT NULL,
	"invested_amount" numeric(12, 2) NOT NULL,
	"invested_stickers" integer NOT NULL,
	"original_invested_stickers" integer NOT NULL,
	"current_value" numeric(12, 2) DEFAULT '0' NOT NULL,
	"days_completed" integer DEFAULT 0 NOT NULL,
	"days_missed" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_resolved" boolean DEFAULT false NOT NULL,
	"final_return" numeric(12, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mw_savings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"saved_stickers" integer DEFAULT 0 NOT NULL,
	"saved_cash" numeric(12, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mw_savings_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"transaction_type" "mw_savings_tx_type" NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"sticker_count" integer DEFAULT 0 NOT NULL,
	"is_reversed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mw_transaction_stickers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"sticker_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mw_week_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"week_id" uuid NOT NULL,
	"action_type" "mw_week_action_type" NOT NULL,
	"stickers_used" integer,
	"cash_amount" numeric(12, 2),
	"reward_name" text,
	"habit_id" uuid,
	"habit_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mw_weeks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"week_number" integer NOT NULL,
	"year" integer NOT NULL,
	"start_date" date NOT NULL,
	"is_finalized" boolean DEFAULT false NOT NULL,
	"carried_over_stickers" integer DEFAULT 0 NOT NULL,
	"carried_over_cash" numeric(12, 2) DEFAULT '0' NOT NULL,
	"retrieved_stickers" integer DEFAULT 0 NOT NULL,
	"retrieved_cash" numeric(12, 2) DEFAULT '0' NOT NULL,
	"closure_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "habits" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "habits" ADD COLUMN "is_bonus" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "habit_stickers" ADD CONSTRAINT "habit_stickers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habit_stickers" ADD CONSTRAINT "habit_stickers_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habit_stickers" ADD CONSTRAINT "habit_stickers_habit_id_habits_id_fk" FOREIGN KEY ("habit_id") REFERENCES "public"."habits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "habit_stickers" ADD CONSTRAINT "habit_stickers_week_id_mw_weeks_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."mw_weeks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mw_investments" ADD CONSTRAINT "mw_investments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mw_investments" ADD CONSTRAINT "mw_investments_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mw_investments" ADD CONSTRAINT "mw_investments_habit_id_habits_id_fk" FOREIGN KEY ("habit_id") REFERENCES "public"."habits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mw_investments" ADD CONSTRAINT "mw_investments_week_id_mw_weeks_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."mw_weeks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mw_savings" ADD CONSTRAINT "mw_savings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mw_savings" ADD CONSTRAINT "mw_savings_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mw_savings_transactions" ADD CONSTRAINT "mw_savings_transactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mw_savings_transactions" ADD CONSTRAINT "mw_savings_transactions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mw_transaction_stickers" ADD CONSTRAINT "mw_transaction_stickers_transaction_id_mw_savings_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."mw_savings_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mw_transaction_stickers" ADD CONSTRAINT "mw_transaction_stickers_sticker_id_habit_stickers_id_fk" FOREIGN KEY ("sticker_id") REFERENCES "public"."habit_stickers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mw_week_actions" ADD CONSTRAINT "mw_week_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mw_week_actions" ADD CONSTRAINT "mw_week_actions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mw_week_actions" ADD CONSTRAINT "mw_week_actions_week_id_mw_weeks_id_fk" FOREIGN KEY ("week_id") REFERENCES "public"."mw_weeks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mw_week_actions" ADD CONSTRAINT "mw_week_actions_habit_id_habits_id_fk" FOREIGN KEY ("habit_id") REFERENCES "public"."habits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mw_weeks" ADD CONSTRAINT "mw_weeks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mw_weeks" ADD CONSTRAINT "mw_weeks_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "habit_stickers_unique" ON "habit_stickers" USING btree ("tenant_id","habit_id","week_id","day");--> statement-breakpoint
CREATE INDEX "habit_stickers_member_week_idx" ON "habit_stickers" USING btree ("tenant_id","member_id","week_id");--> statement-breakpoint
CREATE INDEX "mw_investments_member_idx" ON "mw_investments" USING btree ("tenant_id","member_id");--> statement-breakpoint
CREATE INDEX "mw_investments_active_idx" ON "mw_investments" USING btree ("tenant_id","member_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "mw_savings_member_unique" ON "mw_savings" USING btree ("tenant_id","member_id");--> statement-breakpoint
CREATE INDEX "mw_savings_tx_member_idx" ON "mw_savings_transactions" USING btree ("tenant_id","member_id");--> statement-breakpoint
CREATE INDEX "mw_transaction_stickers_tx_idx" ON "mw_transaction_stickers" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "mw_week_actions_week_idx" ON "mw_week_actions" USING btree ("tenant_id","week_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mw_weeks_member_week_unique" ON "mw_weeks" USING btree ("tenant_id","member_id","year","week_number");--> statement-breakpoint
CREATE INDEX "mw_weeks_member_idx" ON "mw_weeks" USING btree ("tenant_id","member_id");