/**
 * Step bindings for rls-role.feature (FHS-347).
 *
 * Introspects the Postgres catalog (as the superuser test connection) to prove
 * the app_runtime login role Postgres' RLS will police is created correctly and
 * minimally: no BYPASSRLS, no SUPERUSER, owns no tables, exactly CRUD on the
 * tenant tables, and no DDL (so migrations stay on the owner role).
 */

import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect } from 'vitest';
import { TENANT_SCOPED_TABLES } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

const ROLE = 'app_runtime';
const tableNames = TENANT_SCOPED_TABLES.map((t) => getTableConfig(t).name);

let db: Database;

async function assertRoleExists(): Promise<void> {
  db = getTestDb() as unknown as Database;
  const { rows } = await db.execute<{ ok: boolean }>(
    sql`select exists(select 1 from pg_roles where rolname = ${ROLE}) as ok`,
  );
  expect(rows[0]?.ok).toBe(true);
}

const feature = await loadFeature(
  new URL('../features/rls-role.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Scenario }) => {
  Scenario('app_runtime is a policed, non-privileged login', ({ Given, Then, And }) => {
    Given('the app_runtime role exists', assertRoleExists);

    Then('it has neither BYPASSRLS nor SUPERUSER', async () => {
      const { rows } = await db.execute<{ rolbypassrls: boolean; rolsuper: boolean }>(
        sql`select rolbypassrls, rolsuper from pg_roles where rolname = ${ROLE}`,
      );
      expect(rows[0]?.rolbypassrls).toBe(false);
      expect(rows[0]?.rolsuper).toBe(false);
    });

    And('it owns none of the tenant-scoped tables', async () => {
      const { rows } = await db.execute<{ owned: string }>(
        sql`select c.relname as owned
            from pg_class c
            join pg_roles r on r.oid = c.relowner
            where r.rolname = ${ROLE} and c.relkind = 'r'`,
      );
      expect(rows.map((x) => x.owned)).toEqual([]);
    });
  });

  Scenario('app_runtime has exactly CRUD and nothing more', ({ Given, Then, And }) => {
    Given('the app_runtime role exists', assertRoleExists);

    Then('it has SELECT, INSERT, UPDATE and DELETE on every tenant-scoped table', async () => {
      for (const name of tableNames) {
        for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          const { rows } = await db.execute<{ ok: boolean }>(
            sql`select has_table_privilege(${ROLE}, ${`public.${name}`}, ${priv}) as ok`,
          );
          expect(rows[0]?.ok, `${ROLE} should have ${priv} on ${name}`).toBe(true);
        }
      }
    });

    And('it has no TRUNCATE, REFERENCES or TRIGGER privilege on those tables', async () => {
      for (const name of tableNames) {
        for (const priv of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          const { rows } = await db.execute<{ ok: boolean }>(
            sql`select has_table_privilege(${ROLE}, ${`public.${name}`}, ${priv}) as ok`,
          );
          expect(rows[0]?.ok, `${ROLE} should NOT have ${priv} on ${name}`).toBe(false);
        }
      }
    });

    And('it cannot create objects in the public schema', async () => {
      const { rows } = await db.execute<{ ok: boolean }>(
        sql`select has_schema_privilege(${ROLE}, 'public', 'CREATE') as ok`,
      );
      expect(rows[0]?.ok).toBe(false);
    });
  });
});
