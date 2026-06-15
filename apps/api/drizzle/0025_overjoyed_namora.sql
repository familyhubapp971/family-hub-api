CREATE TABLE "world_flags_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"country_code" text NOT NULL,
	"explored_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "world_flags_progress" ADD CONSTRAINT "world_flags_progress_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_flags_progress" ADD CONSTRAINT "world_flags_progress_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "world_flags_progress_unique_idx" ON "world_flags_progress" USING btree ("tenant_id","member_id","country_code");--> statement-breakpoint
CREATE INDEX "world_flags_progress_member_idx" ON "world_flags_progress" USING btree ("tenant_id","member_id");