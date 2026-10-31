-- Rollback for 0016_spooky_iron_lad.sql (FHS-276).
ALTER TABLE "members" DROP COLUMN IF EXISTS "age";
