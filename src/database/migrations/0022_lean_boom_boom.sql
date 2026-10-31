ALTER TABLE "habits" ADD COLUMN "member_id" uuid;--> statement-breakpoint
ALTER TABLE "habits" ADD CONSTRAINT "habits_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "habits_tenant_member_idx" ON "habits" USING btree ("tenant_id","member_id");