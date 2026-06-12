-- Rollback for 0015_goofy_warlock.sql (FHS-275).
ALTER TABLE "pending_invitations" DROP CONSTRAINT IF EXISTS "pending_invitations_member_id_members_id_fk";--> statement-breakpoint
ALTER TABLE "pending_invitations" DROP COLUMN IF EXISTS "member_id";
