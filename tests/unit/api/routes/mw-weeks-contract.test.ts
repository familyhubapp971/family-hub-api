import { describe, it, expect } from 'vitest';
import {
  toWeek,
  weekSchema,
  weekStatsResponseSchema,
  weekActionSchema,
  finalizeRequestSchema,
  weekCashRequestSchema,
} from '../../../../apps/api/src/routes/mw-weeks.js';

// FHS-627: the week endpoints are documented from these schemas, so the docs
// are only true while the schemas match what the handlers actually produce.
// This is the guard: add a field to `toWeek` without adding it to
// `weekSchema` and this fails, rather than the docs quietly going stale.

const row = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  memberId: '33333333-3333-4333-8333-333333333333',
  weekNumber: 31,
  year: 2026,
  startDate: '2026-07-27',
  isFinalized: true,
  carriedOverStickers: 3,
  carriedOverCash: '1.50',
  retrievedStickers: 0,
  retrievedCash: '0.00',
  closureSnapshot: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Parameters<typeof toWeek>[0];

describe('the week endpoints match what they document', () => {
  it('every field toWeek returns is described, and nothing extra', () => {
    const week = toWeek(row);
    // strict() makes an undocumented field an error, not a silent pass.
    expect(() => weekSchema.strict().parse(week)).not.toThrow();
    expect(Object.keys(week).sort()).toEqual(Object.keys(weekSchema.shape).sort());
  });

  it('turns the stored cash strings into numbers, as documented', () => {
    const week = toWeek(row);
    expect(week.carriedOverCash).toBe(1.5);
    expect(week.retrievedCash).toBe(0);
    expect(typeof week.carriedOverCash).toBe('number');
  });

  it('describes a week with no cash carried at all', () => {
    const empty = toWeek({ ...row, carriedOverCash: '0', retrievedCash: '0' } as typeof row);
    expect(() => weekSchema.strict().parse(empty)).not.toThrow();
  });

  it('accepts the stats shape the handler returns', () => {
    expect(() =>
      weekStatsResponseSchema.parse({
        weekId: row.id,
        totalStickers: 21,
        unallocatedStickers: 4,
        allocatedStickers: 17,
        cashValue: 10.5,
      }),
    ).not.toThrow();
  });

  it('accepts every action type a close can record', () => {
    for (const actionType of [
      'claim',
      'cashout',
      'save',
      'invest',
      'withdraw',
      'auto_save',
      'invest_continue',
    ]) {
      expect(() =>
        weekActionSchema.parse({
          id: 1,
          weekId: row.id,
          actionType,
          stickersUsed: 3,
          cashAmount: 1.5,
          rewardName: null,
          habitId: null,
          habitName: null,
          createdAt: '2026-07-27T00:00:00Z',
        }),
      ).not.toThrow();
    }
  });

  it('refuses a body that would corrupt a week', () => {
    // Closing needs a real child.
    expect(finalizeRequestSchema.safeParse({ memberId: 'not-a-uuid' }).success).toBe(false);
    // Cash cannot be negative.
    expect(
      weekCashRequestSchema.safeParse({
        memberId: row.memberId,
        carriedOverCash: -1,
        retrievedCash: 0,
      }).success,
    ).toBe(false);
  });
});
