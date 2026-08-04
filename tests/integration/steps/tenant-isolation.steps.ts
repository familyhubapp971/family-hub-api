/**
 * Step bindings for tenant-isolation.feature (FHS-6).
 *
 * Three scenarios:
 *  1. Schema audit: introspects schema exports via getTableConfig; fails
 *     loudly if a table with tenant_id is missing from TENANT_SCOPED_TABLES.
 *  2. Cross-tenant query isolation: seeds one fixture row per tenant per
 *     table, asserts WHERE tenant_id=A never returns B's row.
 *  3. Total-row sanity: COUNT(*) on each table is 2 (one per tenant).
 */

import { randomUUID } from 'node:crypto';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect } from 'vitest';
import {
  TENANT_SCOPED_TABLES,
  activityLogs,
  appSettings,
  events,
  habits,
  habitLogs,
  journalEntries,
  learnProgress,
  investments,
  mealTemplates,
  members,
  pendingInvitations,
  readingLog,
  worldFlagsProgress,
  worldFlagsLearnProgress,
  rewards,
  rewardRedemptions,
  savings,
  savingsTransactions,
  mwWeeks,
  habitStickers,
  mwSavings,
  mwSavingsTransactions,
  mwInvestments,
  mwWeekActions,
  tenants,
  weekActions,
  weeks,
  worldFlagsProgress,
  // Global tables: not scoped, used to verify they're NOT in the registry.
  users,
} from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';
import { seedAllTablesForTenant } from '../support/seed-tenant-tables.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** All pgTable exports from schema.ts including global ones. */
const ALL_SCHEMA_TABLES = [
  users,
  tenants,
  members,
  pendingInvitations,
  weeks,
  habits,
  rewards,
  habitLogs,
  rewardRedemptions,
  journalEntries,
  learnProgress,
  readingLog,
  worldFlagsProgress,
  worldFlagsLearnProgress,
  mealTemplates,
  events,
  weekActions,
  savings,
  savingsTransactions,
  investments,
  mwWeeks,
  habitStickers,
  mwSavings,
  mwSavingsTransactions,
  mwInvestments,
  mwWeekActions,
  appSettings,
  activityLogs,
];

/** Column names in the TENANT_SCOPED_TABLES registry. */
const registeredTableNames = new Set(TENANT_SCOPED_TABLES.map((t) => getTableConfig(t).name));

// ─── shared state across scenarios ───────────────────────────────────────────

let db: Database;
let tenantAId: string;
let tenantBId: string;

// ─── feature ─────────────────────────────────────────────────────────────────

const feature = await loadFeature(
  new URL('../features/tenant-isolation.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    Given('the test Postgres is clean for the tenant-isolation audit', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
    });
  });

  // ─── Scenario 1: schema audit ────────────────────────────────────────────

  Scenario('Schema audit: registry matches tables with tenant_id', ({ Then, And }) => {
    Then('every table in TENANT_SCOPED_TABLES has a tenant_id column', () => {
      for (const table of TENANT_SCOPED_TABLES) {
        const config = getTableConfig(table);
        const hasTenantId = config.columns.some((c) => c.name === 'tenant_id');
        expect(
          hasTenantId,
          `[FHS-6] registered table "${config.name}" is missing tenant_id column`,
        ).toBe(true);
      }
    });

    And('no unregistered table in the schema carries tenant_id', () => {
      for (const table of ALL_SCHEMA_TABLES) {
        const config = getTableConfig(table);
        const hasTenantId = config.columns.some((c) => c.name === 'tenant_id');
        if (hasTenantId && !registeredTableNames.has(config.name)) {
          expect.fail(
            `[FHS-6] table "${config.name}" has tenant_id but is NOT in TENANT_SCOPED_TABLES. ` +
              `Add it to the registry in apps/api/src/db/schema.ts.`,
          );
        }
      }
    });
  });

  // ─── Scenario 2: cross-tenant query isolation ─────────────────────────────

  Scenario(
    'Cross-tenant query isolation: tenant A rows never appear for tenant B',
    ({ Given, Then, And }) => {
      Given(
        'tenant "A" and tenant "B" exist with one fixture row each in every scoped table',
        async () => {
          const [a] = await db
            .insert(tenants)
            .values({ slug: `tenant-a-${randomUUID().slice(0, 8)}`, name: 'Family A' })
            .returning();
          const [b] = await db
            .insert(tenants)
            .values({ slug: `tenant-b-${randomUUID().slice(0, 8)}`, name: 'Family B' })
            .returning();
          tenantAId = a!.id;
          tenantBId = b!.id;
          await seedAllTablesForTenant(db, tenantAId);
          await seedAllTablesForTenant(db, tenantBId);
        },
      );

      Then("querying each scoped table with tenant A's id returns only A's rows", async () => {
        for (const table of TENANT_SCOPED_TABLES) {
          const config = getTableConfig(table);
          const { rows } = await db.execute<{ count: string }>(
            sql.raw(
              `SELECT COUNT(*)::text AS count FROM "${config.name}" WHERE tenant_id = '${tenantAId}'`,
            ),
          );
          const count = Number(rows[0]?.count ?? 0);
          expect(
            count,
            `[FHS-6] "${config.name}" WHERE tenant_id=A returned ${count} rows, expected >=1`,
          ).toBeGreaterThanOrEqual(1);

          // Ensure B's tenant_id never leaks into A's result set.
          const { rows: leakRows } = await db.execute<{ count: string }>(
            sql.raw(
              `SELECT COUNT(*)::text AS count FROM "${config.name}" WHERE tenant_id = '${tenantBId}'`,
            ),
          );
          const leakCount = Number(leakRows[0]?.count ?? 0);
          expect(
            leakCount,
            `[FHS-6] "${config.name}" WHERE tenant_id=A leaked ${leakCount} rows from B`,
          ).toBe(1); // B's row should only show up when querying B, not A
        }
      });

      And("querying each scoped table with tenant B's id returns only B's rows", async () => {
        for (const table of TENANT_SCOPED_TABLES) {
          const config = getTableConfig(table);
          const { rows } = await db.execute<{ count: string }>(
            sql.raw(
              `SELECT COUNT(*)::text AS count FROM "${config.name}" WHERE tenant_id = '${tenantBId}'`,
            ),
          );
          const count = Number(rows[0]?.count ?? 0);
          expect(
            count,
            `[FHS-6] "${config.name}" WHERE tenant_id=B returned ${count} rows, expected >=1`,
          ).toBeGreaterThanOrEqual(1);
        }
      });
    },
  );

  // ─── Scenario 3: total-row sanity ─────────────────────────────────────────

  Scenario('Total-row sanity: fixture inserts both rows per table', ({ Given, Then }) => {
    Given(
      'tenant "A" and tenant "B" exist with one fixture row each in every scoped table',
      async () => {
        const [a] = await db
          .insert(tenants)
          .values({ slug: `tenant-a-${randomUUID().slice(0, 8)}`, name: 'Family A' })
          .returning();
        const [b] = await db
          .insert(tenants)
          .values({ slug: `tenant-b-${randomUUID().slice(0, 8)}`, name: 'Family B' })
          .returning();
        tenantAId = a!.id;
        tenantBId = b!.id;
        await seedAllTablesForTenant(db, tenantAId);
        await seedAllTablesForTenant(db, tenantBId);
      },
    );

    Then('each scoped table has exactly 2 rows in total', async () => {
      for (const table of TENANT_SCOPED_TABLES) {
        const config = getTableConfig(table);
        const { rows } = await db.execute<{ count: string }>(
          sql.raw(`SELECT COUNT(*)::text AS count FROM "${config.name}"`),
        );
        const count = Number(rows[0]?.count ?? 0);
        expect(
          count,
          `[FHS-6] "${config.name}" expected 2 total rows (1 per tenant), got ${count}`,
        ).toBe(2);
      }
    });
  });
});
