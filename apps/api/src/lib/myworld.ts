import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { habitStickers, mwWeeks, rewardRedemptions, tenants, type MwWeek } from '../db/schema.js';

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

type Db = ReturnType<typeof getDb>;

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

/**
 * Spendable sticker balance = stickers earned (sum of sticker values
 * across the child's habit days) minus stickers spent on rewards. The
 * savings / cash split + per-sticker allocation lands in FHS-294/295; for
 * now this single source keeps the habits + rewards routes consistent.
 */
export async function stickerBalance(db: Db, tenantId: string, memberId: string): Promise<number> {
  const [earnedRow, spentRow] = await Promise.all([
    db
      .select({ s: sql<string>`coalesce(sum(${habitStickers.stickerValue}), 0)` })
      .from(habitStickers)
      .where(and(eq(habitStickers.tenantId, tenantId), eq(habitStickers.memberId, memberId))),
    db
      .select({ s: sql<string>`coalesce(sum(${rewardRedemptions.stickerCost}), 0)` })
      .from(rewardRedemptions)
      .where(
        and(eq(rewardRedemptions.tenantId, tenantId), eq(rewardRedemptions.memberId, memberId)),
      ),
  ]);
  return Number(earnedRow[0]?.s ?? 0) - Number(spentRow[0]?.s ?? 0);
}
