ALTER TABLE "members" ADD COLUMN "pin_hash" text;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "is_child" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "members_tenant_is_child_idx" ON "members" USING btree ("tenant_id","is_child");