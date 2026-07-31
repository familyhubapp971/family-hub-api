import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  habits,
  habitStickers,
  members,
  moneyAdjustments,
  mwSavings,
  tenants,
} from '../db/schema.js';

// FHS-512 — configurable reward economy.
//
// MONEY RULE (non-negotiable): every quantity in this file is an INTEGER in
// the tenant's minor currency unit (e.g. 50 = 0.50 AED) — never a float.
// `rateMinorToDecimal` / `formatMinor` are the ONLY places a minor-unit
// integer is turned into a decimal, and only for display or for feeding the
// legacy `numeric(12,2)` money columns (savedCash, investedAmount, …) that
// predate this ticket. Converting the whole economy to minor-unit columns
// is a separate, larger migration — see ADR 0020, "Alternatives considered".

export const DEFAULT_STICKER_RATE_MINOR = 50; // 0.50 — matches the old fixed STICKER_TO_CASH.
export const BOOST_PRESETS = [2, 3, 5] as const;

type Db =
  | ReturnType<typeof getDb>
  | Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

/**
 * Pure resolver: a child's own rate overrides the family default. No I/O —
 * this is the single source of truth for "which rate applies to this kid",
 * safe to unit-test without a database.
 */
export function effectiveRateMinor(
  child: { stickerRateMinor: number | null | undefined },
  family: { stickerRateMinor: number },
): number {
  return child.stickerRateMinor ?? family.stickerRateMinor;
}

/**
 * Loads (member, tenant) and resolves the effective minor-unit rate for one
 * child. Falls back to {@link DEFAULT_STICKER_RATE_MINOR} if the member row
 * can't be found (defensive — every caller should have already validated
 * the member exists in this tenant).
 */
export async function getEffectiveRateMinor(
  db: Db,
  tenantId: string,
  memberId: string,
): Promise<number> {
  const rows = await db
    .select({ memberRate: members.stickerRateMinor, tenantRate: tenants.stickerRateMinor })
    .from(members)
    .innerJoin(tenants, eq(tenants.id, members.tenantId))
    .where(and(eq(members.tenantId, tenantId), eq(members.id, memberId)))
    .limit(1);
  const row = rows[0];
  if (!row) return DEFAULT_STICKER_RATE_MINOR;
  return effectiveRateMinor(
    { stickerRateMinor: row.memberRate },
    { stickerRateMinor: row.tenantRate },
  );
}

/** Minor-unit rate → decimal currency amount (e.g. 50 → 0.5) for the legacy decimal money columns. */
export function rateMinorToDecimal(rateMinor: number): number {
  return rateMinor / 100;
}

/** Format an integer minor-unit amount as the given ISO-4217 currency (e.g. 150 + "AED" → "AED 1.50"). */
export function formatMinor(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(
      amountMinor / 100,
    );
  } catch {
    // Unknown/invalid currency code — fall back to a plain decimal so the
    // UI never crashes on a bad tenant.currency value.
    return `${currency} ${(amountMinor / 100).toFixed(2)}`;
  }
}

/** The 7 calendar dates (Mon..Sun) covered by an mw_weeks row. */
function weekDayDates(startDate: string): string[] {
  const [y, m, d] = startDate.split('-').map((s) => Number.parseInt(s, 10));
  const out: string[] = [];
  for (let day = 0; day < 7; day += 1) {
    const dt = new Date(Date.UTC(y!, m! - 1, d! + day));
    out.push(dt.toISOString().slice(0, 10));
  }
  return out;
}

export interface SkipPenaltyResult {
  totalPenaltyMinor: number;
  adjustmentsInserted: number;
}

/**
 * Skip-penalty accrual, run once per child inside the close-week transaction
 * (`POST /mw/weeks/:id/finalize`). For every habit with `skip_penalty_minor
 * > 0`, every one of the week's 7 days ON OR AFTER the habit's `createdAt`
 * date that has no `habit_stickers` row is a "due day missed" — see ADR 0020
 * for why every day counts as due (habit cadence isn't otherwise enforced
 * anywhere in the sticker economy). A habit created mid-week is never
 * penalised for days before it existed. Each missed day writes one negative
 * `money_adjustments` row.
 *
 * MONEY RULE (bug fix, three-review blocker): `saved_cash` can never go
 * below 0, so the amount actually DEBITED can be less than the nominal
 * penalty total. The audit trail must equal what was actually debited, or
 * reversing it later (reopen/repair) fabricates money. So: read saved_cash
 * BEFORE deducting, cap the deduction at that amount (`appliedMinor`), and if
 * the nominal total was floored, write ONE extra compensating row (reason
 * 'floor') so the week's adjustment rows sum to exactly -appliedMinor. The
 * returned `totalPenaltyMinor` stays the nominal (un-floored) total — that's
 * what's shown to the family in the close-week summary.
 *
 * PRECONDITION: the caller has already ensured the member's `mw_savings` row
 * exists (every finalize call path does this via `getOrCreateSavings`
 * before calling here).
 */
export async function applySkipPenalties(
  tx: Db,
  tenantId: string,
  memberId: string,
  week: { id: string; startDate: string },
  now: Date = new Date(),
): Promise<SkipPenaltyResult> {
  const habitRows = await tx
    .select({
      id: habits.id,
      skipPenaltyMinor: habits.skipPenaltyMinor,
      createdAt: habits.createdAt,
    })
    .from(habits)
    .where(
      and(
        eq(habits.tenantId, tenantId),
        eq(habits.memberId, memberId),
        isNull(habits.archivedAt),
        gte(habits.skipPenaltyMinor, 1),
      ),
    );
  if (habitRows.length === 0) return { totalPenaltyMinor: 0, adjustmentsInserted: 0 };

  const dates = weekDayDates(week.startDate);
  const habitIds = habitRows.map((h) => h.id);
  const stickerRows = await tx
    .select({ habitId: habitStickers.habitId, day: habitStickers.day })
    .from(habitStickers)
    .where(
      and(
        eq(habitStickers.tenantId, tenantId),
        eq(habitStickers.memberId, memberId),
        eq(habitStickers.weekId, week.id),
      ),
    );
  const placedDaysByHabit = new Map<string, Set<number>>();
  for (const row of stickerRows) {
    if (!habitIds.includes(row.habitId)) continue;
    const set = placedDaysByHabit.get(row.habitId) ?? new Set<number>();
    set.add(row.day);
    placedDaysByHabit.set(row.habitId, set);
  }

  const inserts: Array<{
    tenantId: string;
    memberId: string;
    habitId: string;
    day: string;
    amountMinor: number;
    reason: string;
  }> = [];
  let totalPenaltyMinor = 0;
  for (const habit of habitRows) {
    const placed = placedDaysByHabit.get(habit.id) ?? new Set<number>();
    // FIX 5: a habit created mid-week only owes for days on/after it existed.
    const habitCreatedDate = habit.createdAt.toISOString().slice(0, 10);
    for (let day = 0; day < 7; day += 1) {
      if (placed.has(day)) continue;
      if (dates[day]! < habitCreatedDate) continue;
      inserts.push({
        tenantId,
        memberId,
        habitId: habit.id,
        day: dates[day]!,
        amountMinor: -habit.skipPenaltyMinor,
        reason: 'skip',
      });
      totalPenaltyMinor += habit.skipPenaltyMinor;
    }
  }
  if (inserts.length === 0) return { totalPenaltyMinor: 0, adjustmentsInserted: 0 };

  await tx.insert(moneyAdjustments).values(inserts);

  // FIX 1 — read saved_cash BEFORE deducting so the applied amount (and its
  // audit trail) can never exceed what the child actually had. numeric(_,2)
  // round-trips exactly through *100, so this conversion never loses a cent.
  const savingsRows = await tx
    .select({ savedCash: mwSavings.savedCash })
    .from(mwSavings)
    .where(and(eq(mwSavings.tenantId, tenantId), eq(mwSavings.memberId, memberId)))
    .limit(1);
  const savedCashMinor = Math.round(Number(savingsRows[0]?.savedCash ?? 0) * 100);
  const appliedMinor = Math.min(savedCashMinor, totalPenaltyMinor);

  if (appliedMinor < totalPenaltyMinor) {
    // The nominal penalty exceeded what was available — record ONE
    // compensating row so the week's rows sum to exactly -appliedMinor
    // (what reverseSkipPenalties will restore on reopen/repair).
    await tx.insert(moneyAdjustments).values([
      {
        tenantId,
        memberId,
        habitId: null,
        day: dates[0]!,
        amountMinor: totalPenaltyMinor - appliedMinor,
        reason: 'floor',
      },
    ]);
  }

  const appliedDecimal = rateMinorToDecimal(appliedMinor);
  await tx
    .update(mwSavings)
    .set({
      // GREATEST(...,0) stays as a belt-and-braces safety net — appliedMinor
      // is already capped above, so this should never actually clamp.
      savedCash: sql`GREATEST(${mwSavings.savedCash} - ${appliedDecimal}, 0)`,
      updatedAt: now,
    })
    .where(and(eq(mwSavings.tenantId, tenantId), eq(mwSavings.memberId, memberId)));

  return { totalPenaltyMinor, adjustmentsInserted: inserts.length };
}

export interface SkipPenaltyReversal {
  totalReversedMinor: number;
  rowsDeleted: number;
}

/**
 * Reverses skip-penalty adjustments applied to a given week (matched by
 * `day` falling in the week's Mon–Sun range, since `money_adjustments` has
 * no `week_id`). Restores the reversed amount to `mw_savings.saved_cash`
 * and deletes the audit rows. Called by `POST /mw/weeks/:id/reopen` and
 * `POST /mw/weeks/:id/repair` alongside their existing reversal steps.
 *
 * FIX 1 — matches BOTH `'skip'` and `'floor'` rows. A floored week's rows sum
 * to exactly -appliedMinor (the per-day 'skip' rows PLUS the one positive
 * 'floor' compensating row); reversing only 'skip' rows would restore the
 * full nominal penalty instead of what was actually debited, fabricating
 * money on reopen.
 */
export async function reverseSkipPenalties(
  tx: Db,
  tenantId: string,
  memberId: string,
  week: { startDate: string },
  now: Date = new Date(),
): Promise<SkipPenaltyReversal> {
  const dates = weekDayDates(week.startDate);
  const first = dates[0]!;
  const last = dates[6]!;
  const rows = await tx
    .select({ id: moneyAdjustments.id, amountMinor: moneyAdjustments.amountMinor })
    .from(moneyAdjustments)
    .where(
      and(
        eq(moneyAdjustments.tenantId, tenantId),
        eq(moneyAdjustments.memberId, memberId),
        inArray(moneyAdjustments.reason, ['skip', 'floor']),
        gte(moneyAdjustments.day, first),
        lte(moneyAdjustments.day, last),
      ),
    );
  if (rows.length === 0) return { totalReversedMinor: 0, rowsDeleted: 0 };

  const totalNegativeMinor = rows.reduce((sum, r) => sum + r.amountMinor, 0); // negative
  const restoreMinor = -totalNegativeMinor; // positive amount to add back

  for (const row of rows) {
    await tx.delete(moneyAdjustments).where(eq(moneyAdjustments.id, row.id));
  }

  if (restoreMinor > 0) {
    const restoreDecimal = rateMinorToDecimal(restoreMinor);
    await tx
      .update(mwSavings)
      .set({ savedCash: sql`${mwSavings.savedCash} + ${restoreDecimal}`, updatedAt: now })
      .where(and(eq(mwSavings.tenantId, tenantId), eq(mwSavings.memberId, memberId)));
  }

  return { totalReversedMinor: restoreMinor, rowsDeleted: rows.length };
}

/** Sum of every money_adjustments row for a child, in integer minor units (negative when net-penalised). */
export async function sumAdjustmentsMinor(
  db: Db,
  tenantId: string,
  memberId: string,
): Promise<number> {
  const rows = await db
    .select({ amountMinor: moneyAdjustments.amountMinor })
    .from(moneyAdjustments)
    .where(and(eq(moneyAdjustments.tenantId, tenantId), eq(moneyAdjustments.memberId, memberId)));
  return rows.reduce((sum, r) => sum + r.amountMinor, 0);
}
