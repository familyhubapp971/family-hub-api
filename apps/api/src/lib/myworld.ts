import { and, asc, count, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  habits,
  habitStickers,
  mwInvestments,
  mwSavings,
  mwWeekActions,
  mwWeeks,
  rewardRedemptions,
  rewards,
  tenants,
  type MwWeek,
} from '../db/schema.js';

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
 * Calendar ISO date (YYYY-MM-DD, UTC) of `day` within a week, where
 * `day` is 0=Monday … 6=Sunday and `startDate` is the week's Monday.
 */
export function dayDateOf(startDate: string, day: number): string {
  const [y, m, d] = startDate.split('-').map((s) => Number.parseInt(s, 10));
  return isoDate(new Date(Date.UTC(y!, m! - 1, d! + day)));
}

/**
 * Where a sticker day falls relative to today (UTC). Drives the FHS-335
 * rule: only an admin may edit a *past* day; *today* and later days in the
 * current week stay open to a normal user (the legacy "tick the whole week"
 * behaviour). `now` is injectable for tests. NOTE: "today" is computed in UTC,
 * matching how the rest of My World anchors weeks — see the timezone follow-up.
 */
export function stickerDayRelation(
  startDate: string,
  day: number,
  now: Date = new Date(),
): 'past' | 'today' | 'future' {
  const dayDate = dayDateOf(startDate, day);
  const today = isoDate(now); // ISO date strings compare lexicographically
  if (dayDate < today) return 'past';
  if (dayDate > today) return 'future';
  return 'today';
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
  // Close weeks in order (ported from legacy): if the child has an earlier
  // still-open week, DON'T create the new ISO week — stay on the oldest open
  // one. Otherwise a calendar rollover would strand the open week and its
  // active investment (new stickers land in a fresh week while the investment
  // keeps pointing at the old one → it shows 0/7 done). The next week is
  // created by finalize when the child actually closes.
  const open = await db
    .select()
    .from(mwWeeks)
    .where(
      and(
        eq(mwWeeks.tenantId, tenantId),
        eq(mwWeeks.memberId, memberId),
        eq(mwWeeks.isFinalized, false),
      ),
    )
    .orderBy(asc(mwWeeks.year), asc(mwWeeks.weekNumber))
    .limit(1);
  if (open[0]) return open[0];
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

// The top-level pool db (has `.transaction`) — redeemReward opens its own.
type PoolDb = ReturnType<typeof getDb>;

export type RedeemOutcome =
  | { ok: true; balance: number; redemptionId: string }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'insufficient'; cost: number; balance: number };

/**
 * Spend stickers on a reward for a member (FHS-268). Serialized per
 * (tenant, member) with an advisory lock; spends banked stickers, then saved
 * cash, then this week's unallocated stickers (smallest first). Records a
 * 'claim' week-action + a redemption row. Shared by the parent rewards route
 * and the kid route so the money logic lives in exactly one place.
 */
export async function redeemReward(
  db: PoolDb,
  params: { tenantId: string; memberId: string; rewardId: string },
): Promise<RedeemOutcome> {
  const { tenantId, memberId, rewardId } = params;
  const rewardRows = await db
    .select({ id: rewards.id, stickerCost: rewards.stickerCost, name: rewards.name })
    .from(rewards)
    .where(
      and(eq(rewards.tenantId, tenantId), eq(rewards.id, rewardId), isNull(rewards.archivedAt)),
    )
    .limit(1);
  const reward = rewardRows[0];
  if (!reward) return { ok: false, reason: 'not-found' };
  const cost = reward.stickerCost;
  const week = await getOrCreateCurrentWeek(db, tenantId, memberId);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${memberId}`}, 0))`,
    );
    const savings = await getOrCreateSavings(tx, tenantId, memberId);
    const unallocated = await tx
      .select({ id: habitStickers.id, value: habitStickers.stickerValue })
      .from(habitStickers)
      .where(
        and(
          eq(habitStickers.tenantId, tenantId),
          eq(habitStickers.memberId, memberId),
          eq(habitStickers.isAllocated, false),
        ),
      )
      .orderBy(asc(habitStickers.stickerValue));
    const weekValue = unallocated.reduce((s, r) => s + r.value, 0);
    const cashStk = cashAsStickers(savings.savedCash);
    const balance = savings.savedStickers + cashStk + weekValue;
    if (balance < cost)
      return { ok: false as const, reason: 'insufficient' as const, cost, balance };

    let need = cost;
    const fromSavedStickers = Math.min(need, savings.savedStickers);
    need -= fromSavedStickers;
    const fromSavedCash = Math.min(need, cashStk);
    need -= fromSavedCash;
    const toAllocate: string[] = [];
    let covered = 0;
    for (const r of unallocated) {
      if (covered >= need) break;
      toAllocate.push(r.id);
      covered += r.value;
    }
    if (toAllocate.length > 0) {
      await tx
        .update(habitStickers)
        .set({ isAllocated: true })
        .where(
          and(
            eq(habitStickers.tenantId, tenantId),
            eq(habitStickers.memberId, memberId),
            inArray(habitStickers.id, toAllocate),
          ),
        );
    }
    if (fromSavedStickers > 0 || fromSavedCash > 0) {
      await tx
        .update(mwSavings)
        .set({
          savedStickers: sql`${mwSavings.savedStickers} - ${fromSavedStickers}`,
          savedCash: sql`${mwSavings.savedCash} - ${fromSavedCash * STICKER_TO_CASH}`,
          updatedAt: new Date(),
        })
        .where(and(eq(mwSavings.tenantId, tenantId), eq(mwSavings.memberId, memberId)));
    }
    const [action] = await tx
      .insert(mwWeekActions)
      .values({
        tenantId,
        memberId,
        weekId: week.id,
        actionType: 'claim',
        stickersUsed: cost,
        rewardName: reward.name,
      })
      .returning({ id: mwWeekActions.id });
    await tx.insert(rewardRedemptions).values({ tenantId, rewardId, memberId, stickerCost: cost });
    return { ok: true as const, balance: balance - cost, redemptionId: action!.id };
  });
}

export interface InvestmentView {
  id: string;
  habitId: string;
  habitName: string | null;
  habitIcon: string | null;
  investedStickers: number;
  originalInvestedStickers: number;
  currentValue: number;
  currentValueStickers: number;
  daysCompleted: number;
  daysMissed: number;
}

/**
 * A member's active investments with live value recomputed from this week's
 * stickers (FHS-296). Shared by the parent mw-financial route and the kid
 * route. Read-only — does not persist the recomputed value.
 */
export async function listInvestments(
  db: Db,
  tenantId: string,
  memberId: string,
  now: Date = new Date(),
): Promise<InvestmentView[]> {
  const rows = await db
    .select({
      id: mwInvestments.id,
      habitId: mwInvestments.habitId,
      weekId: mwInvestments.weekId,
      investedStickers: mwInvestments.investedStickers,
      originalInvestedStickers: mwInvestments.originalInvestedStickers,
      habitName: habits.name,
      habitIcon: habits.icon,
      weekIsFinalized: mwWeeks.isFinalized,
      weekStartDate: mwWeeks.startDate,
    })
    .from(mwInvestments)
    .leftJoin(habits, eq(mwInvestments.habitId, habits.id))
    .leftJoin(mwWeeks, eq(mwInvestments.weekId, mwWeeks.id))
    .where(
      and(
        eq(mwInvestments.tenantId, tenantId),
        eq(mwInvestments.memberId, memberId),
        eq(mwInvestments.isActive, true),
      ),
    );
  return Promise.all(
    rows.map(async (inv) => {
      const elapsed = elapsedDaysForWeek(
        {
          isFinalized: inv.weekIsFinalized ?? false,
          startDate: inv.weekStartDate ?? isoDate(now),
        },
        now,
      );
      const [completedRow] = await db
        .select({ n: count() })
        .from(habitStickers)
        .where(
          and(
            eq(habitStickers.tenantId, tenantId),
            eq(habitStickers.memberId, memberId),
            eq(habitStickers.habitId, inv.habitId),
            eq(habitStickers.weekId, inv.weekId),
          ),
        );
      const completedDays = completedRow?.n ?? 0;
      const [pastRow] = await db
        .select({ n: count() })
        .from(habitStickers)
        .where(
          and(
            eq(habitStickers.tenantId, tenantId),
            eq(habitStickers.memberId, memberId),
            eq(habitStickers.habitId, inv.habitId),
            eq(habitStickers.weekId, inv.weekId),
            lt(habitStickers.day, elapsed),
          ),
        );
      const missedDays = Math.max(0, elapsed - (pastRow?.n ?? 0));
      const { currentValueStickers, currentValueCash } = investmentValue({
        investedStickers: inv.investedStickers,
        completedDays,
        missedDays,
      });
      return {
        id: inv.id,
        habitId: inv.habitId,
        habitName: inv.habitName,
        habitIcon: inv.habitIcon,
        investedStickers: inv.investedStickers,
        originalInvestedStickers: inv.originalInvestedStickers,
        currentValue: currentValueCash,
        currentValueStickers,
        daysCompleted: completedDays,
        daysMissed: missedDays,
      };
    }),
  );
}

// ── Analytics (FHS-298 / FHS-369) ────────────────────────────────────────────
const ANALYTICS_INVESTMENT_MULTIPLIER = 2;

export interface MemberAnalytics {
  stickersPerWeek: Array<{
    weekNumber: number;
    year: number;
    startDate: string;
    totalStickers: number;
    daysCompleted: number;
    completionRate: number;
  }>;
  habitStats: Array<{
    habitId: string;
    name: string;
    habitIcon: string | null;
    totalDays: number;
    completedDays: number;
    rate: number;
  }>;
}

/**
 * A member's My World analytics (FHS-298): potential value + completion % per
 * week, and per-habit success rate across all their weeks. Read-only; shared by
 * the parent mw-analytics route and the kid route so the SQL has one home.
 */
export async function computeMemberAnalytics(
  db: Db,
  tenantId: string,
  memberId: string,
): Promise<MemberAnalytics> {
  const [habitCountRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(habits)
    .where(
      and(eq(habits.tenantId, tenantId), eq(habits.memberId, memberId), isNull(habits.archivedAt)),
    );
  const weeklyPossibleDays = Math.max(1, (habitCountRow?.n ?? 0) * 7);

  const stickersPerWeekRows = await db
    .select({
      weekNumber: mwWeeks.weekNumber,
      year: mwWeeks.year,
      startDate: mwWeeks.startDate,
      totalStickers: sql<number>`coalesce(sum(
        ${habitStickers.stickerValue} * CASE WHEN EXISTS (
          SELECT 1 FROM ${mwInvestments}
          WHERE ${mwInvestments.habitId} = ${habitStickers.habitId}
            AND ${mwInvestments.weekId} = ${habitStickers.weekId}
            AND ${mwInvestments.isActive} = true
            AND ${mwInvestments.tenantId} = ${tenantId}
            AND ${mwInvestments.memberId} = ${memberId}
        ) THEN ${ANALYTICS_INVESTMENT_MULTIPLIER} ELSE 1 END
      ), 0)::int`,
      daysCompleted: sql<number>`count(${habitStickers.id})::int`,
    })
    .from(habitStickers)
    .innerJoin(mwWeeks, and(eq(habitStickers.weekId, mwWeeks.id), eq(mwWeeks.tenantId, tenantId)))
    .where(and(eq(habitStickers.tenantId, tenantId), eq(habitStickers.memberId, memberId)))
    .groupBy(mwWeeks.id, mwWeeks.weekNumber, mwWeeks.year, mwWeeks.startDate)
    .orderBy(asc(mwWeeks.year), asc(mwWeeks.weekNumber));

  const stickersPerWeek = stickersPerWeekRows.map((w) => ({
    weekNumber: w.weekNumber,
    year: w.year,
    startDate: w.startDate,
    totalStickers: w.totalStickers ?? 0,
    daysCompleted: w.daysCompleted ?? 0,
    completionRate: Math.min(100, Math.round(((w.daysCompleted ?? 0) / weeklyPossibleDays) * 100)),
  }));

  const [weekCountRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mwWeeks)
    .where(and(eq(mwWeeks.tenantId, tenantId), eq(mwWeeks.memberId, memberId)));
  const possibleDays = (weekCountRow?.n || 1) * 7;

  const habitStatRows = await db
    .select({
      habitId: habits.id,
      name: habits.name,
      habitIcon: habits.icon,
      completedDays: sql<number>`count(${habitStickers.id})::int`,
    })
    .from(habits)
    .leftJoin(
      habitStickers,
      and(
        eq(habitStickers.habitId, habits.id),
        eq(habitStickers.tenantId, tenantId),
        eq(habitStickers.memberId, memberId),
      ),
    )
    .where(
      and(eq(habits.tenantId, tenantId), eq(habits.memberId, memberId), isNull(habits.archivedAt)),
    )
    .groupBy(habits.id, habits.name, habits.icon);

  const habitStats = habitStatRows.map((row) => ({
    habitId: row.habitId,
    name: row.name,
    habitIcon: row.habitIcon,
    totalDays: possibleDays,
    completedDays: row.completedDays ?? 0,
    rate: possibleDays > 0 ? Math.round(((row.completedDays ?? 0) / possibleDays) * 100) : 0,
  }));

  return { stickersPerWeek, habitStats };
}
