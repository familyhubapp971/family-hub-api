import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HABITS,
  DEFAULT_REWARDS,
  seedTenantDefaults,
} from '../../../../apps/api/src/db/seed-tenant-defaults.js';

// FHS-40 — pure-helper tests for the onboarding seed function.
// Schema integration (rows actually land in PG with the right
// tenant_id) is covered by tests/integration/features/onboarding.feature.

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function makeFakeDb() {
  const insertCalls: Array<{ table: unknown; values: unknown[] }> = [];
  const db = {
    insert: (table: unknown) => ({
      values: (rows: unknown[]) => {
        insertCalls.push({ table, values: rows });
        return {
          returning: () => Promise.resolve(rows.map((_, i) => ({ id: `id-${i}` }))),
        };
      },
    }),
  };
  return { db, insertCalls };
}

describe('FHS-40 — seedTenantDefaults', () => {
  it('exposes 5 habits and 3 rewards as the default set', () => {
    expect(DEFAULT_HABITS).toHaveLength(5);
    expect(DEFAULT_REWARDS).toHaveLength(3);
    // Ticket spec: Read, Tidy, Kind, Exercise, Veggies.
    expect(DEFAULT_HABITS.map((h) => h.name)).toEqual([
      'Read',
      'Tidy room',
      'Kind act',
      'Exercise',
      'Eat veggies',
    ]);
  });

  it('inserts the habits + rewards rows with the supplied tenant_id', async () => {
    const { db, insertCalls } = makeFakeDb();
    const counts = await seedTenantDefaults(db, TENANT_ID);

    expect(counts.habitsAdded).toBe(5);
    expect(counts.rewardsAdded).toBe(3);
    // AC: empty meal-template seed.
    expect(counts.mealTemplatesAdded).toBe(0);

    // Two insert batches (habits, rewards). Both rows in each batch
    // must carry tenant_id.
    expect(insertCalls).toHaveLength(2);
    for (const call of insertCalls) {
      const rows = call.values as Array<{ tenantId: string }>;
      for (const row of rows) {
        expect(row.tenantId).toBe(TENANT_ID);
      }
    }
  });

  it('does not check for existing rows — caller owns idempotency', async () => {
    // Calling twice doubles the inserts; this asserts the contract
    // documented in the helper's docstring (the FHS-37 onboarding
    // endpoint guards against re-runs via the onboarding_completed flag).
    const { db, insertCalls } = makeFakeDb();
    await seedTenantDefaults(db, TENANT_ID);
    await seedTenantDefaults(db, TENANT_ID);
    // 2 batches per call × 2 calls = 4 batches total.
    expect(insertCalls).toHaveLength(4);
  });

  it('passes through the rewards sticker costs and icons unchanged', async () => {
    const { db, insertCalls } = makeFakeDb();
    await seedTenantDefaults(db, TENANT_ID);
    const rewardBatch = insertCalls[1]!;
    const rewardRows = rewardBatch.values as Array<{
      name: string;
      stickerCost: number;
      icon?: string;
    }>;
    expect(rewardRows.find((r) => r.name === 'Movie night pick')?.stickerCost).toBe(10);
    expect(rewardRows.find((r) => r.name === 'Movie night pick')?.icon).toBe('🎬');
  });

  // Surface a contract test for the helper's caller: on Postgres the
  // rejection from a duplicate insert will rollback the surrounding
  // transaction. The integration suite (tests/integration/...) covers
  // the real-PG behaviour; here we just confirm the helper doesn't
  // catch errors itself.
  it('propagates errors from the underlying insert', async () => {
    const failing = {
      insert: () => ({
        values: () => ({
          returning: () => Promise.reject(new Error('boom')),
        }),
      }),
    };
    await expect(seedTenantDefaults(failing, TENANT_ID)).rejects.toThrow(/boom/);
  });
});
