-- Rollback for 0017_amused_prism.sql (FHS-266).
ALTER TABLE "notices" DROP COLUMN IF EXISTS "icon";
