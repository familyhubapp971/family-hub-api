import { describe, it, expect } from 'vitest';
import { summariseWeekActions } from '../../../packages/shared/src/week-actions.js';

// FHS-608: one place decides what each week action means, because the parent
// board and the kid recap were each keeping their own copy of these filters.

const a = (actionType: string, stickersUsed: number | null) => ({ actionType, stickersUsed });

describe('summariseWeekActions', () => {
  it('splits a week into saved, invested, spent and cashed out', () => {
    expect(
      summariseWeekActions([
        a('save', 3),
        a('auto_save', 2),
        a('invest', 4),
        a('claim', 6),
        a('cashout', 5),
      ]),
    ).toEqual({ saved: 5, invested: 4, spent: 6, cashedOut: 5, total: 20 });
  });

  // FHS-617: closing a week writes an `invest_continue` carrying the whole
  // value of an investment that keeps running. Counting it reported the same
  // investment again every week: a week that earned 21 claimed 101 invested.
  it('does not count a rolled-over investment as newly invested', () => {
    expect(summariseWeekActions([a('invest_continue', 101)]).invested).toBe(0);
    // A real new investment in the same week still counts, on its own.
    const mixed = summariseWeekActions([a('invest', 8), a('invest_continue', 101)]);
    expect(mixed.invested).toBe(8);
    expect(mixed.total).toBe(8);
  });

  it('nets a withdrawal off what was invested', () => {
    const out = summariseWeekActions([a('invest', 10), a('withdraw', 4)]);
    expect(out.invested).toBe(6);
  });

  it('never reports a negative, even when more came out than went in', () => {
    // Possible when the investment was opened in an earlier week.
    const out = summariseWeekActions([a('invest', 2), a('withdraw', 9)]);
    expect(out.invested).toBe(0);
    expect(out.total).toBe(0);
  });

  it('treats a missing sticker count as nothing', () => {
    expect(summariseWeekActions([a('save', null), a('claim', 3)])).toMatchObject({
      saved: 0,
      spent: 3,
    });
  });

  it('reads an empty week as all zeroes', () => {
    expect(summariseWeekActions([])).toEqual({
      saved: 0,
      invested: 0,
      spent: 0,
      cashedOut: 0,
      total: 0,
    });
  });

  it('ignores an action type it does not know', () => {
    expect(summariseWeekActions([a('something_new', 99), a('save', 1)]).total).toBe(1);
  });
});
