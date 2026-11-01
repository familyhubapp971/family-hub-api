-- FHS-715 / FHS-716: give every existing family its private code, once.
--
-- Run by hand AFTER the api with the new columns (previous_slug, created_by)
-- and the website that forwards old addresses are deployed. Staging first,
-- then production after a backup, at a quiet hour (a grown-up's page left
-- open on the old address needs a reload). Safe to run again: only families
-- that have never been moved are touched.
--
--   railway ssh -i ~/.ssh/id_ed25519_familyhub --project <project> \
--     --environment <env> -s postgres -- \
--     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f -' \
--     < scripts/server/give-families-codes.sql
--
-- What it does:
--   0. Saves every family's id, address and name in fhs715_backup, outside
--      the public schema, so no later deploy can drop it. NEVER redeploy an
--      api older than FHS-715 after this has run: its boot would drop the new
--      columns; this copy is the way back.
--   1. Moves each old family's surname address to previous_slug (old links
--      still reach the family for its own signed-in members) and gives it a
--      private code like e29b-41d4. Old families are the ones with no
--      creator recorded and never moved; families created by the new api
--      already have a creator and a code, and are left alone.
--   2. Records each family's first admin as its creator, for "one family per
--      home".

BEGIN;

CREATE SCHEMA IF NOT EXISTS fhs715_backup;
CREATE TABLE IF NOT EXISTS fhs715_backup.tenant_addresses (
  id uuid PRIMARY KEY,
  slug varchar(63) NOT NULL,
  name text NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fhs715_backup.tenant_addresses (id, slug, name)
SELECT id, slug, name FROM tenants
ON CONFLICT (id) DO NOTHING;

SELECT count(*) AS families_to_move
  FROM tenants
 WHERE created_by IS NULL AND previous_slug IS NULL;

-- One random value per family, from the database's strong random source,
-- computed once in the subquery so both halves of the code come from it. A
-- clash is about one in 4 billion; the unique index would stop the whole
-- run, and running it again fixes it.
UPDATE tenants t
   SET previous_slug = t.slug,
       slug = substr(fresh.h, 1, 4) || '-' || substr(fresh.h, 5, 4),
       updated_at = now()
  FROM (
        SELECT id, replace(gen_random_uuid()::text, '-', '') AS h
          FROM tenants
         WHERE created_by IS NULL AND previous_slug IS NULL
       ) AS fresh
 WHERE t.id = fresh.id;

UPDATE tenants t
   SET created_by = first_admin.user_id
  FROM (
        SELECT DISTINCT ON (tenant_id) tenant_id, user_id
          FROM members
         WHERE role = 'admin' AND user_id IS NOT NULL
         ORDER BY tenant_id, created_at
       ) AS first_admin
 WHERE t.id = first_admin.tenant_id
   AND t.created_by IS NULL;

SELECT count(*) AS families,
       count(previous_slug) AS old_addresses_kept,
       count(created_by) AS creators_recorded,
       count(*) FILTER (WHERE slug !~ '^[0-9a-f]{4}-[0-9a-f]{4}$') AS families_without_a_code
  FROM tenants;

SELECT count(*) AS people_recorded_as_creator_of_more_than_one_family
  FROM (SELECT created_by FROM tenants WHERE created_by IS NOT NULL
        GROUP BY created_by HAVING count(*) > 1) AS several;

COMMIT;
