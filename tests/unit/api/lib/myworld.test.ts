import { describe, expect, it } from 'vitest';
import {
  cashAsStickers,
  dayDateOf,
  elapsedDaysForWeek,
  investmentValue,
  stickerDayRelation,
} from '../../../../apps/api/src/lib/myworld.js';

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
});
