/**
 * Step bindings for rls-tenant-sweep.feature (FHS-350).
 *
 * The exhaustive proof that RLS isolates tenants for EVERY registered table,
 * run as the limited app_runtime role with NO app-level tenant_id filter, so it
 * is the database (not our code) doing the work. FHS-348 proved the mechanism on
 * `members`; this sweeps all 29 tables and adds the write/update/delete edges.
 */

import { randomUUID } from 'node:crypto';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect } from 'vitest';
import { asRuntimeTenant, getTestDb } from '@familyhub/test-utils';
import { TENANT_SCOPED_TABLES, tenants } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { seedAllTablesForTenant } from '../support/seed-tenant-tables.js';

const tableNames = TENANT_SCOPED_TABLES.map((t) => getTableConfig(t).name);

let db: Database;
let tenantAId: string;
let tenantBId: string;

async function seedTwoFamilies(): Promise<void> {
  db = getTestDb() as unknown as Database;
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
  await seedAllTablesForTenant(db, tenantAId);
  await seedAllTablesForTenant(db, tenantBId);
}

const feature = await loadFeature(
  new URL('../features/rls-tenant-sweep.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    Given('two families "A" and "B" fully seeded as the owner', seedTwoFamilies);
  });

  Scenario('with a family pinned, every table returns only that family rows', ({ When, Then }) => {
    let perTable: Array<{ name: string; total: number; foreign: number }> = [];
    When(
      'app_runtime pinned to family "A" selects every tenant-scoped table unfiltered',
      async () => {
        perTable = await asRuntimeTenant(tenantAId, async (c) => {
          const out: Array<{ name: string; total: number; foreign: number }> = [];
          for (const name of tableNames) {
            // No WHERE clause: the database must do the scoping, not us.
            const res = await c.query<{ tenant_id: string }>(`SELECT tenant_id FROM "${name}"`);
            out.push({
              name,
              total: res.rows.length,
              foreign: res.rows.filter((r) => r.tenant_id !== tenantAId).length,
            });
          }
          return out;
        });
      },
    );
    Then('every table returns at least one row and only family "A" rows', () => {
      for (const t of perTable) {
        // Seeding inserts exactly one row per table per tenant, so A sees 1.
        expect(t.total, `${t.name}: expected exactly 1 visible row for family A`).toBe(1);
        expect(t.foreign, `${t.name}: leaked ${t.foreign} non-A rows`).toBe(0);
      }
    });
  });

  Scenario('with no family pinned, every table returns nothing', ({ When, Then }) => {
    let perTable: Array<{ name: string; total: number }> = [];
    When('app_runtime with no family pinned selects every tenant-scoped table', async () => {
      perTable = await asRuntimeTenant(null, async (c) => {
        const out: Array<{ name: string; total: number }> = [];
        for (const name of tableNames) {
          const res = await c.query(`SELECT 1 FROM "${name}"`);
          out.push({ name, total: res.rows.length });
        }
        return out;
      });
    });
    Then('every table returns zero rows', () => {
      for (const t of perTable) {
        expect(t.total, `${t.name}: expected 0 rows with no tenant pinned`).toBe(0);
      }
    });
  });

  Scenario('a write into another family is rejected', ({ When, Then }) => {
    let errCode: string | undefined;
    When('app_runtime pinned to family "A" tries to insert a member for family "B"', async () => {
      try {
        await asRuntimeTenant(tenantAId, async (c) => {
          await c.query('INSERT INTO members (tenant_id, display_name) VALUES ($1, $2)', [
            tenantBId,
            'sneaky',
          ]);
        });
      } catch (e) {
        errCode = (e as { code?: string }).code;
      }
    });
    Then('the insert is rejected', () => {
      // 42501 = the RLS WITH CHECK violation, not some unrelated failure.
      expect(errCode, 'expected an RLS policy violation (42501)').toBe('42501');
    });
  });

  Scenario('a row cannot be moved to another family by update', ({ When, Then }) => {
    let errCode: string | undefined;
    When(
      'app_runtime pinned to family "A" tries to reassign its member to family "B"',
      async () => {
        try {
          await asRuntimeTenant(tenantAId, async (c) => {
            await c.query('UPDATE members SET tenant_id = $1', [tenantBId]);
          });
        } catch (e) {
          errCode = (e as { code?: string }).code;
        }
      },
    );
    Then('the update is rejected and family "A" still owns its member', async () => {
      expect(errCode, 'expected an RLS policy violation (42501)').toBe('42501');
      // Verify as the owner: A's member is untouched, still under A.
      const { rows } = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from members where tenant_id = ${tenantAId}`,
      );
      expect(rows[0]?.n).toBeGreaterThanOrEqual(1);
    });
  });

  Scenario('a delete only affects the pinned family', ({ When, Then }) => {
    When('app_runtime pinned to family "A" deletes all members unfiltered', async () => {
      await asRuntimeTenant(tenantAId, async (c) => {
        await c.query('DELETE FROM members');
      });
    });
    Then('only family "A" members are gone and family "B" keeps its member', async () => {
      const { rows: aRows } = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from members where tenant_id = ${tenantAId}`,
      );
      const { rows: bRows } = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from members where tenant_id = ${tenantBId}`,
      );
      expect(aRows[0]?.n, 'family A members should be deleted').toBe(0);
      expect(bRows[0]?.n, 'family B members must be untouched').toBeGreaterThanOrEqual(1);
    });
  });
});
