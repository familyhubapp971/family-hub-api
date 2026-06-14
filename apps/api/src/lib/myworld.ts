import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { habitStickers, mwSavings, mwWeeks, tenants, type MwWeek } from '../db/schema.js';

// FHS-290 — shared My World economy helpers.
//
// 1 sticker = 0.5 AED. A child's spendable balance = stickers banked in
// savings + stickers earned-but-unallocated in their weeks. Weeks are
// Monday-anchored ISO weeks; one open (non-finalized) week per child.

// One sticker is worth this much in the family's chosen currency. The rate
// is a fixed economy constant (ported from legacy); only the currency the
// amount is shown in varies per family (set at registration).
export const STICKER_TO_CASH = 0.5;
/** @deprecated use STICKER_TO_CASH — kept for any older import. */
export const STICKER_TO_AED = STICKER_TO_CASH;

// Accept either the pool db or a transaction handle (helpers are called
// from inside db.transaction(...) in the claim/save/invest flows).
type Db =
  | ReturnType<typeof getDb>
  | Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

/** The family's ISO-4217 currency (chosen at registration; default USD). */
export async function getTenantCurrency(db: Db, tenantId: string): Promise<string> {
  const rows = await db
    .select({ currency: tenants.currency })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return rows[0]?.currency ?? 'USD';
}

/** UTC Monday of the week containing `d`. */
export function mondayOf(d: Date): Date {
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const shift = day === 0 ? -6 : 1 - day;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + shift));
}

/** ISO-8601 week number + week-year for a date. */
export function isoWeek(d: Date): { weekNumber: number; year: number } {
  // Thursday of this week decides the ISO year.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const year = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  const weekNumber = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return { weekNumber, year };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The child's current open week, creating it if none exists. `now` is
 * injectable for tests (defaults to the real clock).
 */
export async function getOrCreateCurrentWeek(
  db: Db,
  tenantId: string,
  memberId: string,
  now: Date = new Date(),
): Promise<MwWeek> {
  const monday = mondayOf(now);
  const { weekNumber, year } = isoWeek(monday);
  const existing = await db
    .select()
    .from(mwWeeks)
    .where(
      and(
        eq(mwWeeks.tenantId, tenantId),
        eq(mwWeeks.memberId, memberId),
        eq(mwWeeks.year, year),
        eq(mwWeeks.weekNumber, weekNumber),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];
  const [created] = await db
    .insert(mwWeeks)
    .values({ tenantId, memberId, weekNumber, year, startDate: isoDate(monday) })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  // Lost an insert race — re-read.
  const reread = await db
    .select()
    .from(mwWeeks)
    .where(
      and(
        eq(mwWeeks.tenantId, tenantId),
        eq(mwWeeks.memberId, memberId),
        eq(mwWeeks.year, year),
        eq(mwWeeks.weekNumber, weekNumber),
      ),
    )
    .limit(1);
  if (!reread[0])
    throw new Error('mw_weeks get-or-create: re-read after conflict returned nothing');
  return reread[0];
}

/** A child's banked savings (read-only; {0,0} if no row yet). */
export async function getSavings(
  db: Db,
  tenantId: string,
  memberId: string,
): Promise<{ savedStickers: number; savedCash: number }> {
  const rows = await db
    .select({ savedStickers: mwSavings.savedStickers, savedCash: mwSavings.savedCash })
    .from(mwSavings)
    .where(and(eq(mwSavings.tenantId, tenantId), eq(mwSavings.memberId, memberId)))
    .limit(1);
  return {
    savedStickers: rows[0]?.savedStickers ?? 0,
    savedCash: Number(rows[0]?.savedCash ?? 0),
  };
}

/** The child's savings row, creating it (0/0) if absent — for writes. */
export async function getOrCreateSavings(
  db: Db,
  tenantId: string,
  memberId: string,
): Promise<{ savedStickers: number; savedCash: number }> {
  await db.insert(mwSavings).values({ tenantId, memberId }).onConflictDoNothing();
  return getSavings(db, tenantId, memberId);
}

/** Cash savings expressed as whole sticker-equivalents. */
export function cashAsStickers(savedCash: number): number {
  return Math.floor(savedCash / STICKER_TO_CASH);
}

// ── Investments (FHS-296) — sticker-first grow model ─────────────────────────
// currentValueStickers = max(0, investedStickers + completedDays*5 - missedDays*2)
export const INVEST_DAILY_GAIN = 5;
export const INVEST_DAILY_PENALTY = 2;
export const INVEST_MIN_STICKERS = 10;

/** How many days of a week have fully elapsed (0..7), per the legacy rule. */
export function elapsedDaysForWeek(
  week: { isFinalized: boolean; startDate: string },
  now: Date = new Date(),
): number {
  if (week.isFinalized) return 7;
  const [y, m, d] = week.startDate.split('-').map((s) => Number.parseInt(s, 10));
  const start = new Date(Date.UTC(y!, m! - 1, d!));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7); // exclusive next Monday
  if (now >= end) return 7;
  if (now < start) return 0;
  return (now.getUTCDay() + 6) % 7; // Mon=0..Sun=6
}

/** Sticker-first investment value from completed/missed days. */
export function investmentValue(params: {
  investedStickers: number;
  completedDays: number;
  missedDays: number;
}): { currentValueStickers: number; currentValueCash: number } {
  const currentValueStickers = Math.max(
    0,
    params.investedStickers +
      params.completedDays * INVEST_DAILY_GAIN -
      params.missedDays * INVEST_DAILY_PENALTY,
  );
  return { currentValueStickers, currentValueCash: currentValueStickers * STICKER_TO_CASH };
}

/**
 * Spendable sticker balance = stickers earned this/any week but not yet
 * allocated (spent/saved/invested) + stickers banked in savings + saved
 * cash expressed as stickers. Marking a sticker `is_allocated` (claim,
 * save, invest) removes it from this balance. (Ported from legacy.)
 */
export async function stickerBalance(db: Db, tenantId: string, memberId: string): Promise<number> {
  const [unallocRow, savings] = await Promise.all([
    db
      .select({ s: sql<string>`coalesce(sum(${habitStickers.stickerValue}), 0)` })
      .from(habitStickers)
      .where(
        and(
          eq(habitStickers.tenantId, tenantId),
          eq(habitStickers.memberId, memberId),
          eq(habitStickers.isAllocated, false),
        ),
      ),
    getSavings(db, tenantId, memberId),
  ]);
  return Number(unallocRow[0]?.s ?? 0) + savings.savedStickers + cashAsStickers(savings.savedCash);
}
