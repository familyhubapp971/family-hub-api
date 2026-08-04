import { describe, expect, it } from 'vitest';
import { expandWeekOccurrences, weekdayOfIso } from '../../../../apps/api/src/lib/recurrence.js';

// FHS-476: weekly recurring calendar activities (expand-on-read).
//
// `expandWeekOccurrences` is the pure function GET /api/events uses to
// turn one series row into the virtual occurrences that fall inside a
// requested 7-day window. Covers: correct weekdays within a week,
// nothing before the anchor or after the end date, the anchor-day-not-
// in-days case, and open-ended (no end date) series.

interface Row {
  id: string;
  date: string;
  recurrenceDays: number[] | null;
  recurrenceEndDate: string | null;
  title: string;
}

function row(over: Partial<Row>): Row {
  return {
    id: 'e1',
    date: '2026-08-03', // a Monday
    recurrenceDays: null,
    recurrenceEndDate: null,
    title: 'Tennis',
    ...over,
  };
}

describe('weekdayOfIso', () => {
  it('maps 2026-08-03 (a Monday) to 1', () => {
    expect(weekdayOfIso('2026-08-03')).toBe(1);
  });
  it('maps 2026-08-02 (a Sunday) to 0', () => {
    expect(weekdayOfIso('2026-08-02')).toBe(0);
  });
  it('maps 2026-08-08 (a Saturday) to 6', () => {
    expect(weekdayOfIso('2026-08-08')).toBe(6);
  });
});

describe('expandWeekOccurrences: non-recurring rows', () => {
  it('includes a one-off row once when its date sits in the week', () => {
    const out = expandWeekOccurrences([row({ date: '2026-08-04' })], '2026-08-03');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      date: '2026-08-04',
      isRecurring: false,
      seriesStartDate: '2026-08-04',
    });
  });

  it('excludes a one-off row whose date is outside the week', () => {
    const out = expandWeekOccurrences([row({ date: '2026-07-20' })], '2026-08-03');
    expect(out).toHaveLength(0);
  });

  it('treats an empty recurrenceDays array the same as null (one-off)', () => {
    const out = expandWeekOccurrences(
      [row({ date: '2026-08-04', recurrenceDays: [] })],
      '2026-08-03',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ isRecurring: false });
  });
});

describe('expandWeekOccurrences: recurring rows', () => {
  it('emits one occurrence per matching weekday within the week (Tue + Thu)', () => {
    // Anchor Monday 2026-08-03, repeats Tue(2) + Thu(4).
    const out = expandWeekOccurrences(
      [row({ date: '2026-08-03', recurrenceDays: [2, 4] })],
      '2026-08-03',
    );
    expect(out.map((o) => o.date).sort()).toEqual(['2026-08-04', '2026-08-06']);
    expect(out.every((o) => o.isRecurring)).toBe(true);
    expect(out.every((o) => o.seriesStartDate === '2026-08-03')).toBe(true);
    expect(out.every((o) => o.id === 'e1')).toBe(true);
  });

  it('does not render the anchor day itself when its weekday is not in recurrenceDays', () => {
    // Anchor is a Monday (weekday 1), but the series only repeats on
    // Tue/Thu: the anchor date itself must not appear as an occurrence.
    const out = expandWeekOccurrences(
      [row({ date: '2026-08-03', recurrenceDays: [2, 4] })],
      '2026-08-03',
    );
    expect(out.some((o) => o.date === '2026-08-03')).toBe(false);
  });

  it('renders the anchor day when its own weekday IS in recurrenceDays', () => {
    // Anchor Monday (weekday 1), repeats on Mon(1) + Wed(3).
    const out = expandWeekOccurrences(
      [row({ date: '2026-08-03', recurrenceDays: [1, 3] })],
      '2026-08-03',
    );
    expect(out.map((o) => o.date).sort()).toEqual(['2026-08-03', '2026-08-05']);
  });

  it('emits nothing before the series anchor, even on a matching weekday', () => {
    // Anchor is Thursday 2026-08-06; the same week's Tuesday (2026-08-04)
    // is before the anchor and must be excluded even though Tue is a
    // chosen day.
    const out = expandWeekOccurrences(
      [row({ date: '2026-08-06', recurrenceDays: [2, 4] })],
      '2026-08-03',
    );
    expect(out.map((o) => o.date)).toEqual(['2026-08-06']);
  });

  it('emits nothing after recurrenceEndDate (stops repeating)', () => {
    // Anchor Monday 2026-08-03, repeats Tue+Thu, ends 2026-08-04 (so only
    // the first Tuesday counts: the Thursday of the same week is excluded).
    const out = expandWeekOccurrences(
      [row({ date: '2026-08-03', recurrenceDays: [2, 4], recurrenceEndDate: '2026-08-04' })],
      '2026-08-03',
    );
    expect(out.map((o) => o.date)).toEqual(['2026-08-04']);
  });

  it('keeps repeating across multiple weeks when recurrenceEndDate is null (open-ended)', () => {
    const anchor = row({ date: '2026-08-03', recurrenceDays: [2, 4], recurrenceEndDate: null });
    const week1 = expandWeekOccurrences([anchor], '2026-08-03');
    const week4 = expandWeekOccurrences([anchor], '2026-08-24'); // three weeks later
    expect(week1.map((o) => o.date).sort()).toEqual(['2026-08-04', '2026-08-06']);
    expect(week4.map((o) => o.date).sort()).toEqual(['2026-08-25', '2026-08-27']);
  });

  it('a week entirely after recurrenceEndDate produces no occurrences', () => {
    const out = expandWeekOccurrences(
      [row({ date: '2026-08-03', recurrenceDays: [2, 4], recurrenceEndDate: '2026-08-10' })],
      '2026-08-24',
    );
    expect(out).toHaveLength(0);
  });

  it('a week entirely before the anchor produces no occurrences', () => {
    const out = expandWeekOccurrences(
      [row({ date: '2026-08-24', recurrenceDays: [2, 4] })],
      '2026-08-03',
    );
    expect(out).toHaveLength(0);
  });

  it('mixes a one-off and a recurring series in the same call', () => {
    const out = expandWeekOccurrences(
      [
        row({ id: 'one-off', date: '2026-08-05', recurrenceDays: null }),
        row({ id: 'series', date: '2026-08-03', recurrenceDays: [2, 4] }),
      ],
      '2026-08-03',
    );
    expect(out).toHaveLength(3);
    expect(out.filter((o) => o.id === 'one-off')).toHaveLength(1);
    expect(out.filter((o) => o.id === 'series')).toHaveLength(2);
  });
});
