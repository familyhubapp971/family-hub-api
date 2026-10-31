DROP INDEX "meal_templates_tenant_day_slot_uniq";--> statement-breakpoint
ALTER TABLE "meal_templates" ADD COLUMN "member_id" uuid;--> statement-breakpoint
ALTER TABLE "meal_templates" ADD COLUMN "recurring" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_templates" ADD CONSTRAINT "meal_templates_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meal_templates_tenant_member_idx" ON "meal_templates" USING btree ("tenant_id","member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meal_templates_tenant_day_slot_everyone_uniq" ON "meal_templates" USING btree ("tenant_id","day_of_week","slot") WHERE "meal_templates"."member_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "meal_templates_tenant_day_slot_member_uniq" ON "meal_templates" USING btree ("tenant_id","day_of_week","slot","member_id") WHERE "meal_templates"."member_id" is not null;