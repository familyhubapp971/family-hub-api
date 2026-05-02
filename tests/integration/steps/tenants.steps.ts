import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import {
  SEED_DEFAULT_TENANT_ID,
  tenants,
  type NewTenant,
} from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

const feature = await loadFeature(new URL('../features/tenants.feature', import.meta.url).pathname);

describeFeature(feature, ({ Background, Scenario, ScenarioOutline }) => {
  let db: Database;

  Background(({ Given }) => {
    Given('the test Postgres has a clean tenants table', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
    });
  });

  async function insertTenant(values: NewTenant) {
    return db.insert(tenants).values(values).returning();
  }

  async function countBySlug(slug: string) {
    const { rows } = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM tenants WHERE slug = ${slug}`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function totalRows() {
    const { rows } = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM tenants`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  Scenario(
    'Insert with only required fields applies all column defaults',
    ({ When, Then, And }) => {
      let row: typeof tenants.$inferSelect;

      When('I insert a tenant with slug "alpha" and name "Alpha Family"', async () => {
        const [r] = await insertTenant({ slug: 'alpha', name: 'Alpha Family' });
        row = r!;
      });
      Then('the row id is a generated UUID', () => {
        expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      });
      And('the row status is "active"', () => {
        expect(row.status).toBe('active');
      });
      And('the row plan is "starter"', () => {
        expect(row.plan).toBe('starter');
      });
      And('the row timezone is "UTC"', () => {
        expect(row.timezone).toBe('UTC');
      });
      And('the row currency is "USD"', () => {
        expect(row.currency).toBe('USD');
      });
      And('the row has createdAt and updatedAt set', () => {
        expect(row.createdAt).toBeInstanceOf(Date);
        expect(row.updatedAt).toBeInstanceOf(Date);
      });
    },
  );

  Scenario(
    'Slug uniqueness — second insert with same slug rejected',
    ({ Given, When, Then, And }) => {
      let caughtError: unknown;

      Given('a tenant exists with slug "duplicate"', async () => {
        await insertTenant({ slug: 'duplicate', name: 'First Family' });
      });
      When('I insert a tenant with slug "duplicate" and name "Other Family"', async () => {
        try {
          await insertTenant({ slug: 'duplicate', name: 'Other Family' });
        } catch (err) {
          caughtError = err;
        }
      });
      Then('the call rejects with a unique-constraint error', () => {
        expect(caughtError).toBeDefined();
        const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
        expect(message.toLowerCase()).toMatch(/duplicate key|unique constraint|23505/);
      });
      And('exactly 1 row exists with slug "duplicate"', async () => {
        expect(await countBySlug('duplicate')).toBe(1);
      });
    },
  );

  Scenario('Slug length — 64 characters rejected (DNS label cap is 63)', ({ When, Then }) => {
    let caughtError: unknown;

    When('I insert a tenant with a 64-character slug', async () => {
      try {
        await insertTenant({ slug: 'a'.repeat(64), name: 'Too Long' });
      } catch (err) {
        caughtError = err;
      }
    });
    Then('the call rejects with a length-violation error', () => {
      expect(caughtError).toBeDefined();
      const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
      // pg error code 22001 = string_data_right_truncation
      expect(message.toLowerCase()).toMatch(/value too long|22001/);
    });
  });

  Scenario('Slug length — 63 characters accepted (DNS label cap)', ({ When, Then }) => {
    let row: typeof tenants.$inferSelect;

    When('I insert a tenant with a 63-character slug', async () => {
      const [r] = await insertTenant({ slug: 'b'.repeat(63), name: 'Right At Limit' });
      row = r!;
    });
    Then('the row is persisted', () => {
      expect(row.slug.length).toBe(63);
    });
  });

  Scenario('Currency length — 4 characters rejected', ({ When, Then }) => {
    let caughtError: unknown;

    When('I insert a tenant with slug "bad-cur" and currency "USDX"', async () => {
      try {
        await insertTenant({ slug: 'bad-cur', name: 'Bad Currency', currency: 'USDX' });
      } catch (err) {
        caughtError = err;
      }
    });
    Then('the call rejects with a length-violation error', () => {
      expect(caughtError).toBeDefined();
      const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
      expect(message.toLowerCase()).toMatch(/value too long|22001/);
    });
  });

  Scenario('Status enum — arbitrary string rejected', ({ When, Then }) => {
    let caughtError: unknown;

    When('I insert a tenant with slug "bad-status" and status "wonky"', async () => {
      try {
        // Cast to bypass the TS literal type — we are deliberately testing
        // the database-level enum constraint, not the Drizzle type system.
        await insertTenant({
          slug: 'bad-status',
          name: 'Bad Status',
          status: 'wonky' as unknown as 'active',
        });
      } catch (err) {
        caughtError = err;
      }
    });
    Then('the call rejects with an invalid-enum error', () => {
      expect(caughtError).toBeDefined();
      const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
      // pg error code 22P02 = invalid_text_representation; surfaces as "invalid input value for enum"
      expect(message.toLowerCase()).toMatch(/invalid input value for enum|22p02/);
    });
  });

  ScenarioOutline(
    'Status enum — only the three documented values are accepted',
    ({ When, Then }, vars) => {
      let row: typeof tenants.$inferSelect;

      When(`I insert a tenant with slug "<slug>" and status "<status>"`, async () => {
        const [r] = await insertTenant({
          slug: vars['slug']!,
          name: `Status ${vars['status']}`,
          status: vars['status'] as 'active' | 'suspended' | 'archived',
        });
        row = r!;
      });
      Then(`the row status is "<status>"`, () => {
        expect(row.status).toBe(vars['status']);
      });
    },
  );

  Scenario(
    'Frozen SEED_DEFAULT_TENANT_ID — re-insert is idempotent via ON CONFLICT',
    ({ Given, When, Then, And }) => {
      Given(
        'a tenant exists with the frozen SEED_DEFAULT_TENANT_ID and slug "default"',
        async () => {
          await db
            .insert(tenants)
            .values({ id: SEED_DEFAULT_TENANT_ID, slug: 'default', name: 'Default Family' })
            .onConflictDoNothing({ target: tenants.slug });
        },
      );
      When('I run the seed insert for the default tenant a second time', async () => {
        await db
          .insert(tenants)
          .values({ id: SEED_DEFAULT_TENANT_ID, slug: 'default', name: 'Default Family' })
          .onConflictDoNothing({ target: tenants.slug });
      });
      Then('exactly 1 row exists with slug "default"', async () => {
        expect(await countBySlug('default')).toBe(1);
      });
      And('the row id is the SEED_DEFAULT_TENANT_ID', async () => {
        const { rows } = await db.execute<{ id: string }>(
          sql`SELECT id FROM tenants WHERE slug = ${'default'}`,
        );
        expect(rows[0]?.id).toBe(SEED_DEFAULT_TENANT_ID);
      });
    },
  );

  Scenario('Two tenants with different slugs coexist', ({ When, And, Then }) => {
    When('I insert a tenant with slug "alpha" and name "Alpha Family"', async () => {
      await insertTenant({ slug: 'alpha', name: 'Alpha Family' });
    });
    And('I insert a tenant with slug "beta" and name "Beta Family"', async () => {
      await insertTenant({ slug: 'beta', name: 'Beta Family' });
    });
    Then('exactly 2 rows exist in tenants', async () => {
      expect(await totalRows()).toBe(2);
    });
  });
});
