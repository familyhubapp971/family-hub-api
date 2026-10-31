-- FHS-270 — per-day journal model.
--
-- Safe migration order:
--   1. Add enum + new nullable columns (body already made nullable).
--   2. Backfill entry_date from created_at for existing rows.
--   3. Dedupe: if two legacy rows share the same (tenant, member, date)
--      keep the newest (max created_at) and delete the older ones.
--   4. Set entry_date NOT NULL.
--   5. Add the unique index on (tenant_id, member_id, entry_date).

-- 1a. Create the mood enum.
CREATE TYPE "public"."journal_mood" AS ENUM('happy', 'smiling', 'excited', 'laughing', 'surprised', 'nervous', 'grumpy', 'sad');--> statement-breakpoint

-- 1b. Drop NOT NULL on body (may now hold partial entries with only mood/gratitude).
ALTER TABLE "journal_entries" ALTER COLUMN "body" DROP NOT NULL;--> statement-breakpoint

-- 1c. Add new columns — entry_date NULLABLE first so backfill can run.
ALTER TABLE "journal_entries" ADD COLUMN "entry_date" date;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "mood" "journal_mood";--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "gratitude1" text;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "gratitude2" text;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "gratitude3" text;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "quote_index" integer;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "creativity" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint

-- 2. Backfill entry_date from created_at (UTC calendar day).
UPDATE "journal_entries"
SET "entry_date" = (created_at AT TIME ZONE 'UTC')::date
WHERE "entry_date" IS NULL;--> statement-breakpoint

-- 3. Dedupe: for any (tenant_id, member_id, entry_date) that has more than
--    one row, delete all but the row with the highest created_at. Legacy
--    rows are free-text entries; collapsing same-day duplicates is acceptable.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, member_id, entry_date
      ORDER BY created_at DESC
    ) AS rn
  FROM "journal_entries"
)
DELETE FROM "journal_entries"
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);--> statement-breakpoint

-- 4. Now that all rows have a value and dupes are gone, enforce NOT NULL.
ALTER TABLE "journal_entries" ALTER COLUMN "entry_date" SET NOT NULL;--> statement-breakpoint

-- 5. Add the unique constraint that backs the upsert ON CONFLICT target.
CREATE UNIQUE INDEX "journal_entries_tenant_member_date_uniq" ON "journal_entries" USING btree ("tenant_id","member_id","entry_date");
