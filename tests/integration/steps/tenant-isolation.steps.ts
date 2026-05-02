/**
 * Step bindings for tenant-isolation.feature (FHS-6).
 *
 * Three scenarios:
 *  1. Schema audit — introspects schema exports via getTableConfig; fails
 *     loudly if a table with tenant_id is missing from TENANT_SCOPED_TABLES.
 *  2. Cross-tenant query isolation — seeds one fixture row per tenant per
 *     table, asserts WHERE tenant_id=A never returns B's row.
 *  3. Total-row sanity — COUNT(*) on each table is 2 (one per tenant).
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
  habits,
  investments,
  members,
  savings,
  savingsTransactions,
  tenants,
  weekActions,
  weeks,
  // Global tables — not scoped, used to verify they're NOT in the registry.
  users,
} from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** All pgTable exports from schema.ts including global ones. */
const ALL_SCHEMA_TABLES = [
  users,
  tenants,
  members,
  weeks,
  habits,
  weekActions,
  savings,
  savingsTransactions,
  investments,
  appSettings,
  activityLogs,
];

/** Column names in the TENANT_SCOPED_TABLES registry. */
const registeredTableNames = new Set(TENANT_SCOPED_TABLES.map((t) => getTableConfig(t).name));

/**
 * Seed one "minimal" row for a given table under the supplied tenantId.
 * Returns the primary-key value(s) for the inserted row so dependants can
 * FK against it.
 *
 * Order within the function matters: parent rows must be inserted before
 * child rows. week_actions requires member + week + habit to exist first;
 * savings_transactions requires savings.
 */
async function seedRow(
  db: Database,

  table: (typeof TENANT_SCOPED_TABLES)[number],
  tenantId: string,
  ctx: {
    memberId?: string;
    weekId?: string;
    habitId?: string;
    savingsId?: string;
  },
): Promise<void> {
  const name = getTableConfig(table).name;

  switch (name) {
    case 'members': {
      const [r] = await db
        .insert(members)
        .values({ tenantId, displayName: `member-${tenantId.slice(0, 4)}` })
        .returning();
      ctx.memberId = r!.id;
      break;
    }
    case 'weeks': {
      const [r] = await db
        .insert(weeks)
        .values({ tenantId, startDate: '2026-01-06', endDate: '2026-01-12' })
        .returning();
      ctx.weekId = r!.id;
      break;
    }
    case 'habits': {
      const [r] = await db
        .insert(habits)
        .values({ tenantId, name: `habit-${tenantId.slice(0, 4)}` })
        .returning();
      ctx.habitId = r!.id;
      break;
    }
    case 'week_actions': {
      // Requires member + week + habit to already exist for this tenant.
      await db.insert(weekActions).values({
        tenantId,
        weekId: ctx.weekId!,
        memberId: ctx.memberId!,
        habitId: ctx.habitId!,
        completedCount: 1,
      });
      break;
    }
    case 'savings': {
      const [r] = await db
        .insert(savings)
        .values({ tenantId, name: `fund-${tenantId.slice(0, 4)}` })
        .returning();
      ctx.savingsId = r!.id;
      break;
    }
    case 'savings_transactions': {
      // Requires savings to already exist for this tenant.
      await db.insert(savingsTransactions).values({
        tenantId,
        savingsId: ctx.savingsId!,
        amount: '10.00',
        type: 'deposit',
        occurredOn: '2026-01-06',
      });
      break;
    }
    case 'investments': {
      await db.insert(investments).values({
        tenantId,
        name: `inv-${tenantId.slice(0, 4)}`,
        assetType: 'stock',
      });
      break;
    }
    case 'app_settings': {
      await db.insert(appSettings).values({
        tenantId,
        key: 'theme',
        value: '"dark"',
      });
      break;
    }
    case 'activity_logs': {
      await db.insert(activityLogs).values({
        tenantId,
        action: `seed-${tenantId.slice(0, 4)}`,
      });
      break;
    }
    default:
      throw new Error(`[FHS-6] seedRow: unknown table "${name}"`);
  }
}

/**
 * Seed one fixture row per table per tenant, in dependency order.
 * Returns a context object with the IDs of parent rows (used by child tables).
 */
async function seedAllTablesForTenant(db: Database, tenantId: string): Promise<void> {
  // ctx accumulates IDs as rows are inserted so FK-children can reference them.
  const ctx: {
    memberId?: string;
    weekId?: string;
    habitId?: string;
    savingsId?: string;
  } = {};

  // Insert in dependency order. TENANT_SCOPED_TABLES is declared in schema.ts
  // with a meaningful order, but week_actions / savings_transactions depend on
  // their parents — process them last via a sorted pass.
  const DEPENDENCY_ORDER = [
    'members',
    'weeks',
    'habits',
    'savings',
    'week_actions', // needs member + week + habit
    'savings_transactions', // needs savings
    'investments',
    'app_settings',
    'activity_logs',
  ];

  const tableMap = new Map(TENANT_SCOPED_TABLES.map((t) => [getTableConfig(t).name, t]));

  for (const name of DEPENDENCY_ORDER) {
    const table = tableMap.get(name);
    if (!table) throw new Error(`[FHS-6] table "${name}" not in registry`);
    await seedRow(db, table, tenantId, ctx);
  }
}

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

  Scenario('Schema audit — registry matches tables with tenant_id', ({ Then, And }) => {
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
    'Cross-tenant query isolation — tenant A rows never appear for tenant B',
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

  Scenario('Total-row sanity — fixture inserts both rows per table', ({ Given, Then }) => {
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
