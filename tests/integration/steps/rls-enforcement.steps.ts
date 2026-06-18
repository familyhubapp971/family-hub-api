/**
 * Step bindings for rls-enforcement.feature (FHS-348).
 *
 * Proves the RLS policies actually bite, by connecting AS the limited
 * app_runtime role (the superuser test connection would bypass RLS). Seeds two
 * families as the owner, then asserts: structural coverage (every tenant table
 * is RLS-enabled + forced + policied), only-own-rows on an unfiltered select,
 * fail-closed with no tenant pinned, and rejected cross-tenant writes.
 *
 * The exhaustive per-table sweep across all 29 tables lives in FHS-350; this
 * ticket proves the mechanism on the central `members` table.
 */

import { randomUUID } from 'node:crypto';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect } from 'vitest';
import { asRuntimeTenant, getTestDb } from '@familyhub/test-utils';
import { TENANT_SCOPED_TABLES, members, tenants } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';

const tableNames = TENANT_SCOPED_TABLES.map((t) => getTableConfig(t).name);

let db: Database;
let tenantAId: string;
let tenantBId: string;

async function seed(): Promise<void> {
  db = getTestDb() as unknown as Database;
  // The owner (superuser) connection bypasses RLS, so it can seed both families.
  await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
  const [a] = await db
    .insert(tenants)
    .values({ slug: `a-${randomUUID().slice(0, 8)}`, name: 'Family A' })
    .returning();
  const [b] = await db
    .insert(tenants)
    .values({ slug: `b-${randomUUID().slice(0, 8)}`, name: 'Family B' })
    .returning();
  tenantAId = a!.id;
  tenantBId = b!.id;
  await db.insert(members).values({ tenantId: tenantAId, displayName: 'A-member' });
  await db.insert(members).values({ tenantId: tenantBId, displayName: 'B-member' });
}

const feature = await loadFeature(
  new URL('../features/rls-enforcement.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    Given('two families "A" and "B" each seeded with a member as the owner', seed);
  });

  Scenario('every tenant-scoped table has RLS enabled, forced, and policied', ({ Then, And }) => {
    Then('every tenant-scoped table has RLS enabled and forced', async () => {
      const { rows } = await db.execute<{ relname: string; rls: boolean; force: boolean }>(
        sql`select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as force
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'`,
      );
      const byName = new Map(rows.map((r) => [r.relname, r]));
      for (const name of tableNames) {
        expect(byName.get(name)?.rls, `${name}: RLS enabled`).toBe(true);
        expect(byName.get(name)?.force, `${name}: RLS forced`).toBe(true);
      }
    });

    And('every tenant-scoped table has the tenant_isolation policy', async () => {
      const { rows } = await db.execute<{ tablename: string }>(
        sql`select tablename from pg_policies
            where schemaname = 'public' and policyname = 'tenant_isolation'`,
      );
      const policied = new Set(rows.map((r) => r.tablename));
      for (const name of tableNames) {
        expect(policied.has(name), `${name}: tenant_isolation policy present`).toBe(true);
      }
    });
  });

  Scenario('the limited role sees only its own family rows, unfiltered', ({ When, Then }) => {
    let seen: Array<{ tenant_id: string }> = [];
    When('app_runtime pinned to family "A" selects all members with no filter', async () => {
      seen = await asRuntimeTenant(tenantAId, async (c) => {
        const res = await c.query<{ tenant_id: string }>('SELECT tenant_id FROM members');
        return res.rows;
      });
    });
    Then('it sees only family "A" rows', () => {
      expect(seen).toHaveLength(1);
      expect(seen.every((r) => r.tenant_id === tenantAId)).toBe(true);
    });
  });

  Scenario('the limited role with no family pinned sees nothing', ({ When, Then }) => {
    let count = -1;
    When('app_runtime with no family pinned selects all members', async () => {
      count = await asRuntimeTenant(null, async (c) => {
        const res = await c.query('SELECT tenant_id FROM members');
        return res.rows.length;
      });
    });
    Then('it sees zero rows', () => {
      expect(count).toBe(0);
    });
  });

  Scenario('a malformed tenant value fails closed, not with an error', ({ When, Then }) => {
    let count = -1;
    let errored = false;
    When('app_runtime selects all members with a malformed tenant value', async () => {
      try {
        count = await asRuntimeTenant('not-a-uuid', async (c) => {
          const res = await c.query('SELECT tenant_id FROM members');
          return res.rows.length;
        });
      } catch {
        errored = true;
      }
    });
    Then('it sees zero rows without an error', () => {
      expect(errored).toBe(false);
      expect(count).toBe(0);
    });
  });

  Scenario('the limited role cannot write into another family', ({ When, Then }) => {
    let rejected = false;
    When('app_runtime pinned to family "A" inserts a member for family "B"', async () => {
      try {
        await asRuntimeTenant(tenantAId, async (c) => {
          await c.query('INSERT INTO members (tenant_id, display_name) VALUES ($1, $2)', [
            tenantBId,
            'sneaky',
          ]);
        });
      } catch {
        rejected = true;
      }
    });
    Then('the write is rejected', () => {
      expect(rejected).toBe(true);
    });
  });
});
