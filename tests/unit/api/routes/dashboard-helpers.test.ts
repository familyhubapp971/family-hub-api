import { describe, expect, it } from 'vitest';
import {
  computeWeeklyStreak,
  deriveGreetingName,
  deriveStatusText,
  isoDateInTimezone,
  weekdayKeyInTimezone,
} from '../../../../apps/api/src/routes/dashboard.js';

// FHS-262 — pure derivation helpers behind GET /api/dashboard/today.
// These carry the non-trivial logic (weekly streaks, status copy,
// timezone-anchored weekday) so they are unit-tested directly; the
// route test covers wiring and the integration test covers real SQL.

describe('FHS-262 — computeWeeklyStreak', () => {
  const W = (n: number) => `week-${n}`;

  it('counts consecutive completed weeks from the newest', () => {
    const weeksDesc = [W(3), W(2), W(1)];
    const completed = new Set([W(3), W(2)]);
    expect(computeWeeklyStreak(weeksDesc, W(3), completed)).toBe(2);
  });

  it('does not penalise an in-progress current week with no completion yet', () => {
    const weeksDesc = [W(3), W(2), W(1)];
    const completed = new Set([W(2), W(1)]);
    // current week W3 not yet completed → skipped, streak from W2.
    expect(computeWeeklyStreak(weeksDesc, W(3), completed)).toBe(2);
  });

  it('breaks the streak on a gap week', () => {
    const weeksDesc = [W(3), W(2), W(1)];
    const completed = new Set([W(3), W(1)]);
    expect(computeWeeklyStreak(weeksDesc, W(3), completed)).toBe(1);
  });

  it('returns 0 when the member has no completions', () => {
    const weeksDesc = [W(3), W(2), W(1)];
    expect(computeWeeklyStreak(weeksDesc, W(3), new Set())).toBe(0);
  });

  it('returns 0 when there are no weeks', () => {
    expect(computeWeeklyStreak([], null, new Set([W(1)]))).toBe(0);
  });
});

describe('FHS-262 — deriveStatusText', () => {
  it('prioritises pending tasks, pluralising correctly', () => {
    expect(deriveStatusText({ tasksPending: 2, habitsDone: 5, habitsTotal: 5 })).toBe(
      '2 tasks left',
    );
    expect(deriveStatusText({ tasksPending: 1, habitsDone: 0, habitsTotal: 3 })).toBe(
      '1 task left',
    );
  });

  it('says "All done" when nothing is outstanding', () => {
    expect(deriveStatusText({ tasksPending: 0, habitsDone: 3, habitsTotal: 3 })).toBe('All done');
    expect(deriveStatusText({ tasksPending: 0, habitsDone: 0, habitsTotal: 0 })).toBe('All done');
  });

  it('shows habit progress when habits remain but no tasks pend', () => {
    expect(deriveStatusText({ tasksPending: 0, habitsDone: 1, habitsTotal: 3 })).toBe('1/3 habits');
  });
});

describe('FHS-262 — weekdayKeyInTimezone', () => {
  it('returns the lowercase 3-letter weekday in UTC', () => {
    expect(weekdayKeyInTimezone(new Date('2026-06-10T12:00:00Z'), 'UTC')).toBe('wed');
  });

  it('rolls to the next weekday across a timezone boundary', () => {
    // 22:00Z Wed is 02:00 Thu in Asia/Dubai (+04).
    expect(weekdayKeyInTimezone(new Date('2026-06-10T22:00:00Z'), 'Asia/Dubai')).toBe('thu');
  });

  it('falls back to UTC for an unknown timezone', () => {
    expect(weekdayKeyInTimezone(new Date('2026-06-10T12:00:00Z'), 'Not/AZone')).toBe('wed');
  });
});

describe('FHS-262 — isoDateInTimezone + deriveGreetingName (regression)', () => {
  it('anchors the date in the tenant timezone', () => {
    expect(isoDateInTimezone(new Date('2026-05-03T22:00:00.000Z'), 'Asia/Dubai')).toBe(
      '2026-05-04',
    );
  });

  it('derives a capitalised first name from the email local part', () => {
    expect(deriveGreetingName('sarah.khan@example.com')).toBe('Sarah');
    expect(deriveGreetingName('@example.com')).toBe('there');
  });
});
