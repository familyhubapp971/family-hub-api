-- FHS-715 / FHS-716: give every existing family its private code, once.
--
-- Run by hand AFTER the api with the new columns (previous_slug, created_by)
-- and the website that forwards old addresses are deployed. Staging first,
-- then production after a backup. Safe to run again: families that already
-- have a code are left alone.
--
--   railway ssh -i ~/.ssh/id_ed25519_familyhub --project <project> \
--     --environment <env> -s postgres -- \
--     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f -' \
--     < scripts/server/give-families-codes.sql
--
-- What it does:
--   1. created_by: the family's first admin is recorded as its creator, so
--      "one family per home" knows who already has a family.
--   2. The old surname address moves to previous_slug (old links still reach
--      the family for its own signed-in members) and slug becomes a private
--      code like e29b-41d4. Kid tablets set up with the surname ask once for
--      the new code, shown on the Members page.

BEGIN;

SELECT count(*) AS families_still_on_a_surname
  FROM tenants
 WHERE slug !~ '^[0-9a-f]{4}-[0-9a-f]{4}$';

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

-- One random value per family (computed once in the subquery, so both halves
-- of the code come from the same value). A clash is about one in 4 billion;
-- the unique index would stop the whole run, and running it again fixes it.
UPDATE tenants t
   SET previous_slug = t.slug,
       slug = substr(fresh.h, 1, 4) || '-' || substr(fresh.h, 5, 4)
  FROM (
        SELECT id, md5(random()::text || clock_timestamp()::text || id::text) AS h
          FROM tenants
         WHERE slug !~ '^[0-9a-f]{4}-[0-9a-f]{4}$'
       ) AS fresh
 WHERE t.id = fresh.id;

SELECT count(*) AS families_with_a_code,
       count(previous_slug) AS old_addresses_kept,
       count(created_by) AS creators_recorded
  FROM tenants;

COMMIT;
