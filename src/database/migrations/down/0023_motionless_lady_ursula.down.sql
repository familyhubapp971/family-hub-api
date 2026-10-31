-- Rollback for 0023_motionless_lady_ursula.sql (FHS-270 per-day journal).
--
-- NOTE: After this migration body may contain NULLs (entries saved with only
-- mood/gratitude). We set body = '' where NULL before reinstating NOT NULL so
-- the down migration is safe on a DB that was written to after the forward run.

-- 1. Drop the unique index.
DROP INDEX IF EXISTS "journal_entries_tenant_member_date_uniq";

-- 2. Remove the new columns.
ALTER TABLE "journal_entries" DROP COLUMN IF EXISTS "entry_date";
ALTER TABLE "journal_entries" DROP COLUMN IF EXISTS "mood";
ALTER TABLE "journal_entries" DROP COLUMN IF EXISTS "gratitude1";
ALTER TABLE "journal_entries" DROP COLUMN IF EXISTS "gratitude2";
ALTER TABLE "journal_entries" DROP COLUMN IF EXISTS "gratitude3";
ALTER TABLE "journal_entries" DROP COLUMN IF EXISTS "quote_index";
ALTER TABLE "journal_entries" DROP COLUMN IF EXISTS "creativity";

-- 3. Restore body NOT NULL — clear NULLs first.
UPDATE "journal_entries" SET "body" = '' WHERE "body" IS NULL;
ALTER TABLE "journal_entries" ALTER COLUMN "body" SET NOT NULL;

-- 4. Drop the enum.
DROP TYPE IF EXISTS "public"."journal_mood";
