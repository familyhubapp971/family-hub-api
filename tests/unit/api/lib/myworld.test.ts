import { describe, expect, it, vi } from 'vitest';
import {
  cashAsStickers,
  dayDateOf,
  elapsedDaysForWeek,
  investmentValue,
  stickerBalances,
  stickerDayRelation,
  STICKER_TO_CASH,
} from '../../../../apps/api/src/lib/myworld.js';
import { kidSavingsResponseSchema } from '../../../../apps/api/src/routes/kid.js';

// FHS-335 — date helpers behind the "past day is admin-only" rule.
describe('dayDateOf', () => {
  it('maps day 0..6 onto Mon..Sun of the week (UTC)', () => {
    expect(dayDateOf('2026-06-15', 0)).toBe('2026-06-15'); // Monday
    expect(dayDateOf('2026-06-15', 2)).toBe('2026-06-17'); // Wednesday
    expect(dayDateOf('2026-06-15', 6)).toBe('2026-06-21'); // Sunday
  });
  it('rolls over month boundaries', () => {
    expect(dayDateOf('2026-06-29', 6)).toBe('2026-07-05');
  });
});

describe('stickerDayRelation', () => {
  const now = new Date('2026-06-17T12:00:00.000Z'); // Wednesday
  it('classifies a day before today as past', () => {
    expect(stickerDayRelation('2026-06-15', 0, now)).toBe('past'); // Mon
    expect(stickerDayRelation('2026-06-15', 1, now)).toBe('past'); // Tue
  });
  it('classifies today as today', () => {
    expect(stickerDayRelation('2026-06-15', 2, now)).toBe('today'); // Wed
  });
  it('classifies a later day as future', () => {
    expect(stickerDayRelation('2026-06-15', 3, now)).toBe('future'); // Thu
    expect(stickerDayRelation('2026-06-15', 6, now)).toBe('future'); // Sun
  });
});

describe('investmentValue (sticker-first grow model)', () => {
  it('returns the principal when no days have passed', () => {
    expect(investmentValue({ investedStickers: 10, completedDays: 0, missedDays: 0 })).toEqual({
      currentValueStickers: 10,
      currentValueCash: 5,
    });
  });

  it('adds 5 stickers per completed day and subtracts 2 per missed day', () => {
    // 10 + 3*5 - 1*2 = 23
    expect(
      investmentValue({ investedStickers: 10, completedDays: 3, missedDays: 1 })
        .currentValueStickers,
    ).toBe(23);
  });

  it('floors the value at zero — penalties never make it go negative', () => {
    expect(
      investmentValue({ investedStickers: 10, completedDays: 0, missedDays: 9 })
        .currentValueStickers,
    ).toBe(0);
  });

  // Locks the partial-withdraw model: after a partial withdraw the principal is
  // reduced by the FULL withdrawn amount and can legitimately go negative when
  // growth pushed the value above the original stake. The recalc re-adds the
  // day-gains, so the formula still yields the correct remaining value. Clamping
  // the principal to 0 here would re-inflate the withdrawn growth — this test
  // guards against that regression.
  it('honours a negative principal so partial withdraws never double-count growth', () => {
    // invested 10, completed 5 -> value 35. Withdraw 30 -> principal 10-30 = -20.
    // remaining value must be 35-30 = 5, recomputed as max(0, -20 + 5*5) = 5.
    expect(
      investmentValue({ investedStickers: -20, completedDays: 5, missedDays: 0 })
        .currentValueStickers,
    ).toBe(5);
  });

  it('converts sticker value to cash at the 0.5 rate', () => {
    expect(
      investmentValue({ investedStickers: 10, completedDays: 2, missedDays: 0 }).currentValueCash,
    ).toBe(10); // 20 stickers * 0.5
  });

  // FHS-378 — deductible vs non-deductible.
  it('applies the missed-day penalty when deductible is true (default + explicit)', () => {
    // 10 + 0*5 - 3*2 = 4, the same with deductible omitted or set true.
    expect(
      investmentValue({ investedStickers: 10, completedDays: 0, missedDays: 3 })
        .currentValueStickers,
    ).toBe(4);
    expect(
      investmentValue({ investedStickers: 10, completedDays: 0, missedDays: 3, deductible: true })
        .currentValueStickers,
    ).toBe(4);
  });

  it('ignores the missed-day penalty when deductible is false', () => {
    // Missed days still passed in (counted/shown) but never subtract value.
    expect(
      investmentValue({ investedStickers: 10, completedDays: 0, missedDays: 3, deductible: false })
        .currentValueStickers,
    ).toBe(10);
    // Completed-day gains still apply on a non-deductible investment.
    expect(
      investmentValue({ investedStickers: 10, completedDays: 2, missedDays: 5, deductible: false })
        .currentValueStickers,
    ).toBe(20); // 10 + 2*5 - 0
  });

  it('still floors at zero for a deductible investment with heavy misses', () => {
    expect(
      investmentValue({ investedStickers: 4, completedDays: 0, missedDays: 9, deductible: true })
        .currentValueStickers,
    ).toBe(0);
  });

  // FHS-534 — the per-investment coefficient drives the daily gain.
  it('defaults the daily gain to 5 when no coefficient is given (legacy rate)', () => {
    // 10 + 4*5 = 30, identical to pre-FHS-534 behaviour.
    expect(
      investmentValue({ investedStickers: 10, completedDays: 4, missedDays: 0 })
        .currentValueStickers,
    ).toBe(30);
  });

  it('grows by `dailyGain` per completed day when a coefficient is supplied', () => {
    // coefficient 3: 10 + 4*3 = 22 (AC — "grows by 3 per completed day").
    expect(
      investmentValue({ investedStickers: 10, completedDays: 4, missedDays: 0, dailyGain: 3 })
        .currentValueStickers,
    ).toBe(22);
    // coefficient 2: 10 + 4*2 = 18.
    expect(
      investmentValue({ investedStickers: 10, completedDays: 4, missedDays: 0, dailyGain: 2 })
        .currentValueStickers,
    ).toBe(18);
    // coefficient 1: 10 + 4*1 = 14 (slowest).
    expect(
      investmentValue({ investedStickers: 10, completedDays: 4, missedDays: 0, dailyGain: 1 })
        .currentValueStickers,
    ).toBe(14);
  });

  it('keeps the missed-day penalty fixed at 2 regardless of the coefficient', () => {
    // coefficient 3 gains, but a missed day still costs 2: 10 + 2*3 - 1*2 = 14.
    expect(
      investmentValue({ investedStickers: 10, completedDays: 2, missedDays: 1, dailyGain: 3 })
        .currentValueStickers,
    ).toBe(14);
  });
});

describe('elapsedDaysForWeek', () => {
  const week = (startDate: string, isFinalized = false) => ({ startDate, isFinalized });

  it('returns 7 once the week is finalized regardless of date', () => {
    expect(elapsedDaysForWeek(week('2026-06-15', true), new Date('2026-06-15T00:00:00Z'))).toBe(7);
  });

  it('returns 0 on the Monday the week starts (no full days elapsed)', () => {
    // 2026-06-15 is a Monday.
    expect(elapsedDaysForWeek(week('2026-06-15'), new Date('2026-06-15T10:00:00Z'))).toBe(0);
  });

  it('returns the count of elapsed days mid-week', () => {
    // Thursday of the same week -> Mon=0, Tue=1, Wed=2, Thu=3.
    expect(elapsedDaysForWeek(week('2026-06-15'), new Date('2026-06-18T10:00:00Z'))).toBe(3);
  });

  it('caps at 7 once the week has fully passed', () => {
    expect(elapsedDaysForWeek(week('2026-06-15'), new Date('2026-06-30T00:00:00Z'))).toBe(7);
  });

  it('returns 0 for a future week not yet started', () => {
    expect(elapsedDaysForWeek(week('2026-06-15'), new Date('2026-06-01T00:00:00Z'))).toBe(0);
  });
});

describe('cashAsStickers', () => {
  it('floors saved cash into whole stickers at the 0.5 rate', () => {
    expect(cashAsStickers(2)).toBe(4);
    expect(cashAsStickers(2.4)).toBe(4); // 2.4/0.5 = 4.8 -> 4
    expect(cashAsStickers(0)).toBe(0);
  });

  // FIX 2 (BLOCKER) — a rate of 0 must never be divided by: with real saved
  // cash and no guard, 2/0 is Infinity, so `balance < cost` never blocks a
  // redemption ("free unlimited redemption"). A rate <= 0 resolves to 0
  // stickers instead of dividing.
  it('resolves to 0 stickers instead of dividing when the rate is 0 or negative', () => {
    expect(cashAsStickers(2, 0)).toBe(0);
    expect(cashAsStickers(100, 0)).toBe(0);
    expect(cashAsStickers(2, -0.5)).toBe(0);
  });
});

// FHS-463 — stickerBalances() batches the per-member star balance into a FIXED
// number of queries (grouped SUM over unallocated stickers, one over savings,
// one over rates — FHS-512 added the third for the configurable rate)
// instead of the 2×N fan-out of calling stickerBalance() per member. The value
// per member is identical: unallocated + saved stickers + cash-as-stickers
// (now at each member's own effective rate, not a fixed 0.5).
describe('stickerBalances (FHS-463 — batched per-member star balance)', () => {
  // Minimal db stub: each db.select() resolves to the next canned result set,
  // no matter where the builder chain stops (.from / .innerJoin / .where / .groupBy).
  function stubDb(resultSets: unknown[]) {
    let call = 0;
    const chain = (rows: unknown): unknown => {
      const obj: Record<string, unknown> = {
        from: () => obj,
        innerJoin: () => obj,
        where: () => obj,
        groupBy: () => obj,
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      };
      return obj;
    };
    const select = vi.fn(() => chain(resultSets[call++]));
    return { db: { select } as unknown as Parameters<typeof stickerBalances>[0], select };
  }

  it('sums unallocated + saved stickers + cash-as-stickers (at each member rate) in three queries', async () => {
    const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const { db, select } = stubDb([
      [{ memberId: A, s: '4' }], // B earned no unallocated stickers this window
      [{ memberId: A, savedStickers: 2, savedCash: '1.50' }], // B has no savings row
      [
        { memberId: A, memberRate: null, tenantRate: 50 }, // A uses the family default (0.50)
        { memberId: B, memberRate: 75, tenantRate: 50 }, // B has an override (0.75) — irrelevant, B has no cash
      ],
    ]);
    const balances = await stickerBalances(db, 'tenant', [A, B]);
    // A: 4 unallocated + 2 saved + floor(1.50 / 0.5)=3 = 9. B: nothing = 0.
    expect(balances.get(A)).toBe(9);
    expect(balances.get(B)).toBe(0);
    // Exactly three round-trips regardless of member count (was 2×members before FHS-463).
    expect(select).toHaveBeenCalledTimes(3);
  });

  it('uses a member override rate (not the family default) when converting saved cash to stickers', async () => {
    const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const { db } = stubDb([
      [], // no unallocated stickers
      [{ memberId: A, savedStickers: 0, savedCash: '3.00' }],
      [{ memberId: A, memberRate: 100, tenantRate: 50 }], // A's own rate: 1.00/star
    ]);
    const balances = await stickerBalances(db, 'tenant', [A]);
    // floor(3.00 / 1.00) = 3 stars, NOT floor(3.00 / 0.5) = 6.
    expect(balances.get(A)).toBe(3);
  });

  it('returns an empty map and issues no query when given no members', async () => {
    const { db, select } = stubDb([]);
    const balances = await stickerBalances(db, 'tenant', []);
    expect(balances.size).toBe(0);
    expect(select).not.toHaveBeenCalled();
  });
});

// FHS-387 — kid savings response includes stickerRate so the UI never hardcodes 0.5.
// FHS-512 — stickerRate is now the child's CONFIGURABLE effective rate, and
// stickerRateMinor carries the same rate as a money-safe integer.
describe('kidSavingsResponseSchema includes stickerRate', () => {
  it('validates a response that includes stickerRate = STICKER_TO_CASH (0.5) and stickerRateMinor', () => {
    const payload = {
      savedStickers: 5,
      savedCash: 2.5,
      currency: 'AED',
      stickerRate: STICKER_TO_CASH,
      stickerRateMinor: 50,
    };
    const result = kidSavingsResponseSchema.safeParse(payload);
    expect(result.success).toBe(true);
    expect(result.data?.stickerRate).toBe(0.5);
    expect(result.data?.stickerRateMinor).toBe(50);
  });

  it('validates a non-default configured rate', () => {
    const payload = {
      savedStickers: 5,
      savedCash: 2.5,
      currency: 'AED',
      stickerRate: 0.75,
      stickerRateMinor: 75,
    };
    const result = kidSavingsResponseSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('rejects a response missing stickerRate', () => {
    const payload = { savedStickers: 5, savedCash: 2.5, currency: 'AED', stickerRateMinor: 50 };
    const result = kidSavingsResponseSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('rejects a response missing stickerRateMinor', () => {
    const payload = { savedStickers: 5, savedCash: 2.5, currency: 'AED', stickerRate: 0.5 };
    const result = kidSavingsResponseSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});
