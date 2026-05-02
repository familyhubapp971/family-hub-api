import { randomUUID } from 'node:crypto';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { eq, sql } from 'drizzle-orm';
import { expect } from 'vitest';
import {
  habits,
  investments,
  members,
  savings,
  savingsTransactions,
  tenants,
  weekActions,
  weeks,
} from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

const feature = await loadFeature(
  new URL('../features/tenants-core.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  // Per-scenario tenant id lookup so steps stay readable.
  const tenantIds: Record<string, string> = {};

  Background(({ Given, And }) => {
    Given('the test Postgres has a clean tenants and core tables', async () => {
      db = getTestDb() as unknown as Database;
      // CASCADE drops dependent rows in the 7 core tables in one shot.
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      // Reset per-scenario lookup.
      for (const k of Object.keys(tenantIds)) delete tenantIds[k];
    });

    And('tenants "alpha" and "beta" exist', async () => {
      const [a] = await db
        .insert(tenants)
        .values({ slug: `alpha-${randomUUID().slice(0, 8)}`, name: 'Alpha Family' })
        .returning();
      const [b] = await db
        .insert(tenants)
        .values({ slug: `beta-${randomUUID().slice(0, 8)}`, name: 'Beta Family' })
        .returning();
      tenantIds['alpha'] = a!.id;
      tenantIds['beta'] = b!.id;
    });
  });

  // ─── members ─────────────────────────────────────────────────────────────

  Scenario('Insert a member with required fields applies role default', ({ When, Then, And }) => {
    let row: typeof members.$inferSelect;

    When('I insert a member into "alpha" with display name "Yusuf"', async () => {
      const [r] = await db
        .insert(members)
        .values({ tenantId: tenantIds['alpha']!, displayName: 'Yusuf' })
        .returning();
      row = r!;
    });
    Then('the member row role is "adult"', () => {
      expect(row.role).toBe('adult');
    });
    And('the member belongs to "alpha"', () => {
      expect(row.tenantId).toBe(tenantIds['alpha']);
    });
  });

  Scenario('Member FK rejects a bogus tenant_id', ({ When, Then }) => {
    let caught: unknown;

    When('I insert a member with a random non-existent tenant_id', async () => {
      try {
        await db.insert(members).values({ tenantId: randomUUID(), displayName: 'Orphan' });
      } catch (err) {
        caught = err;
      }
    });
    Then('the call rejects with a foreign-key violation', () => {
      const message = caught instanceof Error ? caught.message : String(caught);
      // pg error code 23503 = foreign_key_violation
      expect(message.toLowerCase()).toMatch(/foreign key|23503/);
    });
  });

  Scenario('Member user_id is nullable so invitees can exist pre-signup', ({ When, Then }) => {
    let row: typeof members.$inferSelect;

    When(
      'I insert a member into "alpha" with display name "Pending Invitee" and no user_id',
      async () => {
        const [r] = await db
          .insert(members)
          .values({ tenantId: tenantIds['alpha']!, displayName: 'Pending Invitee' })
          .returning();
        row = r!;
      },
    );
    Then('the member row is persisted with user_id null', () => {
      expect(row.userId).toBeNull();
    });
  });

  // ─── weeks ───────────────────────────────────────────────────────────────

  Scenario(
    'Two weeks in the same tenant on the same start_date are rejected',
    ({ Given, When, Then }) => {
      let caught: unknown;

      Given('a week exists in "alpha" starting on "2026-05-04"', async () => {
        await db
          .insert(weeks)
          .values({
            tenantId: tenantIds['alpha']!,
            startDate: '2026-05-04',
            endDate: '2026-05-10',
          });
      });
      When('I insert another week in "alpha" starting on "2026-05-04"', async () => {
        try {
          await db.insert(weeks).values({
            tenantId: tenantIds['alpha']!,
            startDate: '2026-05-04',
            endDate: '2026-05-10',
          });
        } catch (err) {
          caught = err;
        }
      });
      Then('the call rejects with a unique-constraint error', () => {
        const message = caught instanceof Error ? caught.message : String(caught);
        expect(message.toLowerCase()).toMatch(/duplicate key|unique constraint|23505/);
      });
    },
  );

  Scenario('Same start_date is allowed across different tenants', ({ Given, When, Then }) => {
    let row: typeof weeks.$inferSelect;

    Given('a week exists in "alpha" starting on "2026-05-04"', async () => {
      await db
        .insert(weeks)
        .values({ tenantId: tenantIds['alpha']!, startDate: '2026-05-04', endDate: '2026-05-10' });
    });
    When('I insert a week in "beta" starting on "2026-05-04"', async () => {
      const [r] = await db
        .insert(weeks)
        .values({ tenantId: tenantIds['beta']!, startDate: '2026-05-04', endDate: '2026-05-10' })
        .returning();
      row = r!;
    });
    Then('the row is persisted', () => {
      expect(row.id).toBeDefined();
    });
  });

  // ─── habits + week_actions ───────────────────────────────────────────────

  Scenario('Habit cadence enum rejects an unknown value', ({ When, Then }) => {
    let caught: unknown;

    When('I insert a habit into "alpha" with cadence "occasionally"', async () => {
      try {
        await db.insert(habits).values({
          tenantId: tenantIds['alpha']!,
          name: 'Bad Cadence',
          cadence: 'occasionally' as unknown as 'daily',
        });
      } catch (err) {
        caught = err;
      }
    });
    Then('the call rejects with an invalid-enum error', () => {
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message.toLowerCase()).toMatch(/invalid input value for enum|22p02/);
    });
  });

  Scenario(
    'week_actions unique on (week_id, member_id, habit_id)',
    ({ Given, And, When, Then }) => {
      let caught: unknown;
      const ctx: { weekId?: string; memberId?: string; habitId?: string } = {};

      Given('a habit, member, and week exist in "alpha"', async () => {
        const tid = tenantIds['alpha']!;
        const [w] = await db
          .insert(weeks)
          .values({ tenantId: tid, startDate: '2026-05-04', endDate: '2026-05-10' })
          .returning();
        const [m] = await db
          .insert(members)
          .values({ tenantId: tid, displayName: 'Yusuf' })
          .returning();
        const [h] = await db.insert(habits).values({ tenantId: tid, name: 'Read' }).returning();
        ctx.weekId = w!.id;
        ctx.memberId = m!.id;
        ctx.habitId = h!.id;
      });
      And('a week_action records that member completing that habit in that week', async () => {
        await db.insert(weekActions).values({
          tenantId: tenantIds['alpha']!,
          weekId: ctx.weekId!,
          memberId: ctx.memberId!,
          habitId: ctx.habitId!,
          completedCount: 3,
        });
      });
      When('I insert another week_action with the same week, member, and habit', async () => {
        try {
          await db.insert(weekActions).values({
            tenantId: tenantIds['alpha']!,
            weekId: ctx.weekId!,
            memberId: ctx.memberId!,
            habitId: ctx.habitId!,
            completedCount: 1,
          });
        } catch (err) {
          caught = err;
        }
      });
      Then('the call rejects with a unique-constraint error', () => {
        const message = caught instanceof Error ? caught.message : String(caught);
        expect(message.toLowerCase()).toMatch(/duplicate key|unique constraint|23505/);
      });
    },
  );

  // ─── savings_transactions ────────────────────────────────────────────────

  Scenario(
    'savings_transactions type enum accepts deposit and withdrawal',
    ({ Given, When, And, Then }) => {
      let savingsId: string;

      Given('a savings goal exists in "alpha"', async () => {
        const [s] = await db
          .insert(savings)
          .values({ tenantId: tenantIds['alpha']!, name: 'Hajj fund' })
          .returning();
        savingsId = s!.id;
      });
      When('I insert a deposit transaction of "100.00" against that goal', async () => {
        await db.insert(savingsTransactions).values({
          tenantId: tenantIds['alpha']!,
          savingsId,
          amount: '100.00',
          type: 'deposit',
          occurredOn: '2026-05-01',
        });
      });
      And('I insert a withdrawal transaction of "25.00" against that goal', async () => {
        await db.insert(savingsTransactions).values({
          tenantId: tenantIds['alpha']!,
          savingsId,
          amount: '25.00',
          type: 'withdrawal',
          occurredOn: '2026-05-02',
        });
      });
      Then('exactly 2 transactions exist for that goal', async () => {
        const { rows } = await db.execute<{ count: string }>(
          sql`SELECT COUNT(*)::text AS count FROM savings_transactions WHERE savings_id = ${savingsId}`,
        );
        expect(Number(rows[0]?.count ?? 0)).toBe(2);
      });
    },
  );

  Scenario('savings_transactions type enum rejects unknown values', ({ Given, When, Then }) => {
    let savingsId: string;
    let caught: unknown;

    Given('a savings goal exists in "alpha"', async () => {
      const [s] = await db
        .insert(savings)
        .values({ tenantId: tenantIds['alpha']!, name: 'Hajj fund' })
        .returning();
      savingsId = s!.id;
    });
    When('I insert a transaction with type "transfer" against that goal', async () => {
      try {
        await db.insert(savingsTransactions).values({
          tenantId: tenantIds['alpha']!,
          savingsId,
          amount: '50.00',
          type: 'transfer' as unknown as 'deposit',
          occurredOn: '2026-05-01',
        });
      } catch (err) {
        caught = err;
      }
    });
    Then('the call rejects with an invalid-enum error', () => {
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message.toLowerCase()).toMatch(/invalid input value for enum|22p02/);
    });
  });

  // ─── investments ─────────────────────────────────────────────────────────

  Scenario('investments asset_type enum accepts the documented set', ({ When, Then }) => {
    const types = ['stock', 'etf', 'bond', 'crypto', 'real_estate', 'other'] as const;

    When('I insert investments in "alpha" of every documented asset_type', async () => {
      for (const t of types) {
        await db.insert(investments).values({
          tenantId: tenantIds['alpha']!,
          name: `Test ${t}`,
          assetType: t,
        });
      }
    });
    Then('6 investments exist in "alpha"', async () => {
      const { rows } = await db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count FROM investments WHERE tenant_id = ${tenantIds['alpha']!}`,
      );
      expect(Number(rows[0]?.count ?? 0)).toBe(6);
    });
  });

  // ─── tenant isolation ────────────────────────────────────────────────────

  Scenario(
    'Cascade delete — dropping tenant alpha removes all alpha rows; beta survives',
    ({ Given, And, When, Then }) => {
      async function seedFullTenant(tid: string, prefix: string) {
        const [m] = await db
          .insert(members)
          .values({ tenantId: tid, displayName: `${prefix} member` })
          .returning();
        const [w] = await db
          .insert(weeks)
          .values({ tenantId: tid, startDate: '2026-05-04', endDate: '2026-05-10' })
          .returning();
        const [h] = await db
          .insert(habits)
          .values({ tenantId: tid, name: `${prefix} habit` })
          .returning();
        await db.insert(weekActions).values({
          tenantId: tid,
          weekId: w!.id,
          memberId: m!.id,
          habitId: h!.id,
          completedCount: 1,
        });
        const [s] = await db
          .insert(savings)
          .values({ tenantId: tid, name: `${prefix} fund` })
          .returning();
        await db.insert(savingsTransactions).values({
          tenantId: tid,
          savingsId: s!.id,
          amount: '10.00',
          type: 'deposit',
          occurredOn: '2026-05-01',
        });
        await db.insert(investments).values({
          tenantId: tid,
          name: `${prefix} investment`,
          assetType: 'stock',
        });
      }

      Given(
        'tenant "alpha" has a member, week, habit, week_action, savings, transaction, and investment',
        async () => {
          await seedFullTenant(tenantIds['alpha']!, 'alpha');
        },
      );
      And(
        'tenant "beta" has a member, week, habit, week_action, savings, transaction, and investment',
        async () => {
          await seedFullTenant(tenantIds['beta']!, 'beta');
        },
      );
      When('I delete tenant "alpha"', async () => {
        await db.delete(tenants).where(eq(tenants.id, tenantIds['alpha']!));
      });
      Then(
        'no members, weeks, habits, week_actions, savings, savings_transactions, or investments exist for "alpha"',
        async () => {
          const tid = tenantIds['alpha']!;
          const tables = [
            'members',
            'weeks',
            'habits',
            'week_actions',
            'savings',
            'savings_transactions',
            'investments',
          ];
          for (const table of tables) {
            const { rows } = await db.execute<{ count: string }>(
              sql.raw(`SELECT COUNT(*)::text AS count FROM "${table}" WHERE tenant_id = '${tid}'`),
            );
            expect(Number(rows[0]?.count ?? 0), `${table} should be empty for alpha`).toBe(0);
          }
        },
      );
      And('every "beta" row survives untouched', async () => {
        const tid = tenantIds['beta']!;
        const tables = [
          { t: 'members', expected: 1 },
          { t: 'weeks', expected: 1 },
          { t: 'habits', expected: 1 },
          { t: 'week_actions', expected: 1 },
          { t: 'savings', expected: 1 },
          { t: 'savings_transactions', expected: 1 },
          { t: 'investments', expected: 1 },
        ];
        for (const { t, expected } of tables) {
          const { rows } = await db.execute<{ count: string }>(
            sql.raw(`SELECT COUNT(*)::text AS count FROM "${t}" WHERE tenant_id = '${tid}'`),
          );
          expect(Number(rows[0]?.count ?? 0), `${t} for beta`).toBe(expected);
        }
      });
    },
  );
});
