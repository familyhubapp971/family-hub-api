// FHS-476 — weekly recurring calendar activities (expand-on-read).
//
// A recurring activity is stored as ONE row: `date` is the series
// anchor (its first occurrence), `recurrenceDays` is the set of
// weekdays (0=Sunday..6=Saturday) it repeats on, and `recurrenceEndDate`
// is the optional last day it repeats (inclusive). No row is ever
// written per occurrence — `GET /api/events` calls `expandWeekOccurrences`
// to compute the virtual occurrences that fall inside the requested
// week, on every read.
//
// All date math works on plain YYYY-MM-DD strings anchored at UTC, the
// same convention `apps/api/src/routes/events.ts` already uses, so
// there's no timezone drift.

export interface RecurrenceFields {
  date: string;
  recurrenceDays: number[] | null;
  recurrenceEndDate: string | null;
}

export interface WeekOccurrence extends RecurrenceFields {
  isRecurring: boolean;
  seriesStartDate: string;
}

// Add `days` calendar days to an ISO YYYY-MM-DD string, UTC-anchored.
function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((s) => Number.parseInt(s, 10));
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** 0 = Sunday .. 6 = Saturday, matching `recurrenceDays`. */
export function weekdayOfIso(iso: string): number {
  const [y, m, d] = iso.split('-').map((s) => Number.parseInt(s, 10));
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/**
 * Expands a list of event-like rows into the occurrences that fall
 * inside the 7-day window starting at `weekStart` (inclusive).
 *
 * - A non-recurring row (`recurrenceDays` null/empty) is included
 *   as-is, once, only if its own `date` sits in the window.
 * - A recurring row is included once per day in the window whose
 *   weekday is in `recurrenceDays`, is on/after the series anchor
 *   `date`, and is on/before `recurrenceEndDate` (when set). Each
 *   occurrence carries the SAME fields as the source row except
 *   `date`, which becomes that occurrence's own date — so the anchor
 *   day itself only renders when its own weekday is one of the chosen
 *   days (there's no special case for it; it's just one of the seven
 *   candidate days like any other).
 *
 * Every returned item also carries `seriesStartDate` — the original,
 * un-overwritten anchor date — so a caller editing a non-anchor
 * occurrence (e.g. the Thursday half of a Tue/Thu series) can PUT back
 * the real series `date` instead of silently moving the anchor to
 * whichever day happened to be clicked.
 */
export function expandWeekOccurrences<T extends RecurrenceFields>(
  items: readonly T[],
  weekStart: string,
): Array<T & { isRecurring: boolean; seriesStartDate: string }> {
  const weekDays = Array.from({ length: 7 }, (_, i) => addDaysIso(weekStart, i));
  const out: Array<T & { isRecurring: boolean; seriesStartDate: string }> = [];

  for (const item of items) {
    const anchor = item.date;
    const days = item.recurrenceDays;
    if (!days || days.length === 0) {
      if (weekDays.includes(item.date)) {
        out.push({ ...item, isRecurring: false, seriesStartDate: anchor });
      }
      continue;
    }

    const daySet = new Set(days);
    for (const occurrenceDate of weekDays) {
      if (occurrenceDate < anchor) continue; // before the series anchor
      if (item.recurrenceEndDate && occurrenceDate > item.recurrenceEndDate) continue; // after the end
      if (!daySet.has(weekdayOfIso(occurrenceDate))) continue; // not a chosen weekday
      out.push({ ...item, date: occurrenceDate, isRecurring: true, seriesStartDate: anchor });
    }
  }

  return out;
}
