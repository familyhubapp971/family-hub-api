import { describe, expect, it, vi } from 'vitest';
import {
  applySkipPenalties,
  BOOST_PRESETS,
  DEFAULT_STICKER_RATE_MINOR,
  effectiveRateMinor,
  formatMinor,
  rateMinorToDecimal,
  reverseSkipPenalties,
  sumAdjustmentsMinor,
} from '../../../../apps/api/src/lib/reward-config.js';

// FHS-512: configurable reward economy. MONEY-CRITICAL: every quantity here
// is an integer minor-unit amount (e.g. 50 = 0.50): these tests exist to
// catch a float creeping back in or a rate resolving to the wrong value.

const TENANT_ID = 'tenant-1';
const MEMBER_ID = 'member-1';

describe('effectiveRateMinor (pure resolver)', () => {
  it('uses the family default when the child has no override', () => {
    expect(effectiveRateMinor({ stickerRateMinor: null }, { stickerRateMinor: 50 })).toBe(50);
  });
  it('uses the family default when the child override is undefined', () => {
    expect(effectiveRateMinor({ stickerRateMinor: undefined }, { stickerRateMinor: 50 })).toBe(50);
  });
  it("uses the child's own override when set", () => {
    expect(effectiveRateMinor({ stickerRateMinor: 75 }, { stickerRateMinor: 50 })).toBe(75);
  });
  // FIX 2 (BLOCKER): a rate of 0 is no longer a valid value ANYWHERE in the
  // system: it makes cashAsStickers divide by 0 (free unlimited redemption).
  // The PUT /api/reward-config schema now rejects 0 at the boundary (see
  // tests/unit/api/routes/reward-config.test.ts: "400 on a zero
  // familyRateMinor" / "400 on a zero memberOverrides rateMinor"), so a
  // stored override of 0 can no longer be written via the API. This resolver
  // stays a pure, unvalidated arithmetic helper: it is not the enforcement
  // point.
  it('DEFAULT_STICKER_RATE_MINOR matches the legacy fixed 0.5 rate', () => {
    expect(DEFAULT_STICKER_RATE_MINOR).toBe(50);
  });
});

describe('rateMinorToDecimal', () => {
  it('converts minor units to a decimal currency amount', () => {
    expect(rateMinorToDecimal(50)).toBe(0.5);
    expect(rateMinorToDecimal(0)).toBe(0);
    expect(rateMinorToDecimal(199)).toBeCloseTo(1.99);
  });
});

describe('formatMinor', () => {
  it('formats an integer minor amount as the given currency', () => {
    expect(formatMinor(150, 'USD')).toMatch(/1\.50/);
    expect(formatMinor(0, 'AED')).toMatch(/0\.00/);
  });
  it('falls back to a plain decimal string for an invalid currency code', () => {
    expect(formatMinor(150, 'NOTACODE')).toBe('NOTACODE 1.50');
  });
});

describe('BOOST_PRESETS', () => {
  it('exposes the three UI presets', () => {
    expect(BOOST_PRESETS).toEqual([2, 3, 5]);
  });
});

// ── applySkipPenalties / reverseSkipPenalties ────────────────────────────────
//
// Fake `tx`: select() returns a thenable chain resolving to the next queued
// result set (mirrors the pattern used across the rest of the test suite);
// insert()/update()/delete() are spies that record their arguments.

function fakeTx(selectQueue: unknown[][]) {
  const inserted: Array<{ table: unknown; values: unknown }> = [];
  const updated: Array<{ table: unknown; set: unknown }> = [];
  const deleted: Array<{ table: unknown }> = [];
  let call = 0;
  const chain = (): unknown => {
    const rows = selectQueue[call++] ?? [];
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => obj,
      limit: () => obj,
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return obj;
  };
  const tx = {
    select: vi.fn(() => chain()),
    insert: vi.fn((table: unknown) => ({
      values: (values: unknown) => {
        inserted.push({ table, values });
        return Promise.resolve(undefined);
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (set: unknown) => {
        updated.push({ table, set });
        return { where: () => Promise.resolve(undefined) };
      },
    })),
    delete: vi.fn((table: unknown) => ({
      where: () => {
        deleted.push({ table });
        return Promise.resolve(undefined);
      },
    })),
  };
  return { tx, inserted, updated, deleted };
}

describe('applySkipPenalties: skip-penalty accrual at close-week', () => {
  const WEEK = { id: 'week-1', startDate: '2026-06-15' }; // Monday
  // Habit existed well before this week: every day is due. Every fixture
  // below needs a createdAt (FIX 5 reads it unconditionally per habit).
  const OLD_HABIT_CREATED = new Date('2026-01-01T00:00:00.000Z');
  // A savings balance comfortably above any penalty total used in these
  // tests, so the FIX 1 floor path never triggers here: floor behaviour has
  // its own dedicated tests below.
  const AMPLE_SAVINGS = [{ savedCash: '1000.00' }];

  it('does nothing when the child has no habits with a skip penalty', async () => {
    const { tx, inserted, updated } = fakeTx([[]]); // habits query → empty
    const result = await applySkipPenalties(tx as never, TENANT_ID, MEMBER_ID, WEEK);
    expect(result).toEqual({ totalPenaltyMinor: 0, adjustmentsInserted: 0 });
    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it('penalises every one of the 7 days when NO sticker was placed all week', async () => {
    const { tx, inserted, updated } = fakeTx([
      [{ id: 'habit-1', skipPenaltyMinor: 25, createdAt: OLD_HABIT_CREATED }], // habits with a penalty
      [], // no stickers placed this week for this habit
      AMPLE_SAVINGS,
    ]);
    const result = await applySkipPenalties(tx as never, TENANT_ID, MEMBER_ID, WEEK);
    expect(result.totalPenaltyMinor).toBe(7 * 25); // 175
    expect(result.adjustmentsInserted).toBe(7);
    expect(inserted).toHaveLength(1);
    const rows = inserted[0]!.values as Array<{ day: string; amountMinor: number; reason: string }>;
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.amountMinor === -25)).toBe(true);
    expect(rows.every((r) => r.reason === 'skip')).toBe(true);
    // Days map onto the week's actual calendar dates (Mon 15th .. Sun 21st).
    expect(rows.map((r) => r.day)).toEqual([
      '2026-06-15',
      '2026-06-16',
      '2026-06-17',
      '2026-06-18',
      '2026-06-19',
      '2026-06-20',
      '2026-06-21',
    ]);
    expect(updated).toHaveLength(1); // saved_cash was decremented once
  });

  it('only penalises days that are actually missing a sticker', async () => {
    const { tx, inserted } = fakeTx([
      [{ id: 'habit-1', skipPenaltyMinor: 25, createdAt: OLD_HABIT_CREATED }],
      [
        { habitId: 'habit-1', day: 0 },
        { habitId: 'habit-1', day: 1 },
        { habitId: 'habit-1', day: 3 },
      ], // days 0,1,3 done → days 2,4,5,6 missed
      AMPLE_SAVINGS,
    ]);
    const result = await applySkipPenalties(tx as never, TENANT_ID, MEMBER_ID, WEEK);
    expect(result.adjustmentsInserted).toBe(4);
    expect(result.totalPenaltyMinor).toBe(4 * 25);
    const rows = inserted[0]!.values as Array<{ day: string }>;
    expect(rows.map((r) => r.day)).toEqual([
      '2026-06-17',
      '2026-06-19',
      '2026-06-20',
      '2026-06-21',
    ]);
  });

  it('a habit with zero missed days (perfect week) accrues no penalty', async () => {
    const allDays = Array.from({ length: 7 }, (_, day) => ({ habitId: 'habit-1', day }));
    const { tx, inserted, updated } = fakeTx([
      [{ id: 'habit-1', skipPenaltyMinor: 25, createdAt: OLD_HABIT_CREATED }],
      allDays,
    ]);
    const result = await applySkipPenalties(tx as never, TENANT_ID, MEMBER_ID, WEEK);
    expect(result).toEqual({ totalPenaltyMinor: 0, adjustmentsInserted: 0 });
    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it('sums penalties across multiple habits independently', async () => {
    const { tx, inserted } = fakeTx([
      [
        { id: 'habit-1', skipPenaltyMinor: 10, createdAt: OLD_HABIT_CREATED },
        { id: 'habit-2', skipPenaltyMinor: 50, createdAt: OLD_HABIT_CREATED },
      ],
      [
        { habitId: 'habit-1', day: 0 }, // habit-1: 6 days missed
        { habitId: 'habit-2', day: 0 },
        { habitId: 'habit-2', day: 1 }, // habit-2: 5 days missed
      ],
      AMPLE_SAVINGS,
    ]);
    const result = await applySkipPenalties(tx as never, TENANT_ID, MEMBER_ID, WEEK);
    // habit-1: 6 * 10 = 60. habit-2: 5 * 50 = 250. Total = 310.
    expect(result.totalPenaltyMinor).toBe(310);
    expect(result.adjustmentsInserted).toBe(11);
    expect(inserted).toHaveLength(1); // one batched insert for both habits
  });

  it('never inserts a positive amountMinor for a skip row: a penalty row is always negative', async () => {
    const { tx, inserted } = fakeTx([
      [{ id: 'habit-1', skipPenaltyMinor: 30, createdAt: OLD_HABIT_CREATED }],
      [],
      AMPLE_SAVINGS,
    ]);
    await applySkipPenalties(tx as never, TENANT_ID, MEMBER_ID, WEEK);
    const rows = inserted[0]!.values as Array<{ amountMinor: number }>;
    expect(rows.every((r) => r.amountMinor < 0)).toBe(true);
  });

  // ── FIX 5: a habit created mid-week owes nothing for days before it existed ──

  it('does not penalise days before the habit existed (created mid-week)', async () => {
    // Habit created Wednesday (day 2) of the WEEK Mon 2026-06-15 .. Sun 2026-06-21.
    const { tx, inserted } = fakeTx([
      [
        {
          id: 'habit-1',
          skipPenaltyMinor: 25,
          createdAt: new Date('2026-06-17T09:00:00.000Z'),
        },
      ],
      [], // no stickers placed at all
      AMPLE_SAVINGS,
    ]);
    const result = await applySkipPenalties(tx as never, TENANT_ID, MEMBER_ID, WEEK);
    // Only Wed..Sun (5 days) are due: Mon/Tue predate the habit.
    expect(result.adjustmentsInserted).toBe(5);
    expect(result.totalPenaltyMinor).toBe(5 * 25);
    const rows = inserted[0]!.values as Array<{ day: string }>;
    expect(rows.map((r) => r.day)).toEqual([
      '2026-06-17',
      '2026-06-18',
      '2026-06-19',
      '2026-06-20',
      '2026-06-21',
    ]);
  });

  // ── FIX 1 (BLOCKER): the audit trail must equal what was actually debited ──

  it('floors the deduction to available saved_cash and records a compensating "floor" row so the audit trail equals the actual debit', async () => {
    // Penalty totals 175 (7 days × 25) but the child only has 100 (1.00) saved.
    const { tx, inserted, updated } = fakeTx([
      [{ id: 'habit-1', skipPenaltyMinor: 25, createdAt: OLD_HABIT_CREATED }],
      [],
      [{ savedCash: '1.00' }],
    ]);
    const result = await applySkipPenalties(tx as never, TENANT_ID, MEMBER_ID, WEEK);
    // The REPORTED total stays the nominal (un-floored) penalty...
    expect(result.totalPenaltyMinor).toBe(175);
    expect(result.adjustmentsInserted).toBe(7);
    // ...but a second insert call records the compensating row so the week's
    // rows sum to exactly -100 (what was actually available/debited).
    expect(inserted).toHaveLength(2);
    const floorRows = inserted[1]!.values as Array<{
      amountMinor: number;
      reason: string;
      habitId: string | null;
    }>;
    expect(floorRows).toHaveLength(1);
    expect(floorRows[0]!.amountMinor).toBe(75); // 175 - 100 = 75 positive comp row
    expect(floorRows[0]!.reason).toBe('floor');
    expect(floorRows[0]!.habitId).toBeNull();
    expect(updated).toHaveLength(1); // saved_cash deducted by exactly 100 (1.00)
  });

  it('does not write a compensating row when saved_cash fully covers the penalty', async () => {
    const { tx, inserted } = fakeTx([
      [{ id: 'habit-1', skipPenaltyMinor: 25, createdAt: OLD_HABIT_CREATED }],
      [],
      [{ savedCash: '1.75' }], // exactly 175 minor: covers the penalty exactly
    ]);
    const result = await applySkipPenalties(tx as never, TENANT_ID, MEMBER_ID, WEEK);
    expect(result.totalPenaltyMinor).toBe(175);
    expect(inserted).toHaveLength(1); // only the skip batch: no floor row
  });
});

describe('reverseSkipPenalties: reopen/repair undoes the accrual', () => {
  const WEEK = { startDate: '2026-06-15' };

  it('does nothing when no penalty rows exist for the week', async () => {
    const { tx, deleted, updated } = fakeTx([[]]);
    const result = await reverseSkipPenalties(tx as never, TENANT_ID, MEMBER_ID, WEEK);
    expect(result).toEqual({ totalReversedMinor: 0, rowsDeleted: 0 });
    expect(deleted).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it('deletes every matching adjustment and restores the total to saved_cash', async () => {
    const { tx, deleted, updated } = fakeTx([
      [
        { id: 'adj-1', amountMinor: -25 },
        { id: 'adj-2', amountMinor: -25 },
        { id: 'adj-3', amountMinor: -50 },
      ],
    ]);
    const result = await reverseSkipPenalties(tx as never, TENANT_ID, MEMBER_ID, WEEK);
    expect(result.totalReversedMinor).toBe(100); // 25+25+50
    expect(result.rowsDeleted).toBe(3);
    expect(deleted).toHaveLength(3); // one delete per row
    expect(updated).toHaveLength(1); // one saved_cash restore
  });

  // FIX 1 (BLOCKER): a floored week's rows include a positive 'floor'
  // compensating row alongside the negative 'skip' rows. Reversal must sum
  // BOTH kinds (matched by `reason IN ('skip', 'floor')` in the real query)
  // so it restores exactly what was debited, not the full nominal penalty:
  // otherwise closing then reopening a week fabricates money.
  it("restores exactly what was applied (not the nominal total) when the week's rows include a 'floor' compensating row", async () => {
    const { tx, deleted, updated } = fakeTx([
      [
        // 7 days × 25 = -175 nominal, but only 100 was actually available:
        // this is what applySkipPenalties would have written for that case.
        { id: 'adj-1', amountMinor: -25 },
        { id: 'adj-2', amountMinor: -25 },
        { id: 'adj-3', amountMinor: -25 },
        { id: 'adj-4', amountMinor: -25 },
        { id: 'adj-5', amountMinor: -25 },
        { id: 'adj-6', amountMinor: -25 },
        { id: 'adj-7', amountMinor: -25 },
        { id: 'adj-8', amountMinor: 75 }, // the 'floor' comp row
      ],
    ]);
    const result = await reverseSkipPenalties(tx as never, TENANT_ID, MEMBER_ID, WEEK);
    // -175 + 75 = -100 → restores 100, NOT the nominal 175.
    expect(result.totalReversedMinor).toBe(100);
    expect(result.rowsDeleted).toBe(8);
    expect(deleted).toHaveLength(8);
    expect(updated).toHaveLength(1);
  });
});

describe('sumAdjustmentsMinor', () => {
  it('sums every adjustment row for the member (negative = net penalised)', async () => {
    const { tx } = fakeTx([[{ amountMinor: -25 }, { amountMinor: -50 }, { amountMinor: 10 }]]);
    const total = await sumAdjustmentsMinor(tx as never, TENANT_ID, MEMBER_ID);
    expect(total).toBe(-65);
  });
  it('returns 0 for a member with no adjustments', async () => {
    const { tx } = fakeTx([[]]);
    const total = await sumAdjustmentsMinor(tx as never, TENANT_ID, MEMBER_ID);
    expect(total).toBe(0);
  });
});
