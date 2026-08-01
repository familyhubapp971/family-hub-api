import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  habits,
  habitStickers,
  mwInvestments,
  mwSavings,
  mwSavingsTransactions,
  mwTransactionStickers,
  mwWeekActions,
  mwWeeks,
} from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { loadCaller, canManage, isAdmin, memberInTenant } from '../lib/permissions.js';
import {
  getOrCreateCurrentWeek,
  getOrCreateSavings,
  investmentValue,
  isoWeek,
  loadWeekActions,
  loadWeeksForMember,
  loadWeekStats,
  mondayOf,
} from '../lib/myworld.js';
import {
  applySkipPenalties,
  getEffectiveRateMinor,
  rateMinorToDecimal,
  reverseSkipPenalties,
} from '../lib/reward-config.js';

// FHS-293 — My World weeks list / current / stats endpoints.
//
// All three routes share the same auth chain as habits.ts:
//   1. authenticated user (JWT)
//   2. tenant context (400 TENANT_REQUIRED if missing)
//   3. caller must be a member of this tenant (403)
//   4. target member must be in this tenant (404)
//   5. caller must be that member OR admin/adult (403)

const memberQuerySchema = z.object({ memberId: z.string().uuid() });

// ─── shared guards (mirrors habits.ts) ───────────────────────────────────────

type Db = ReturnType<typeof getDb>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function badRequest(c: any, error: z.ZodError) {
  return c.json(
    {
      error: 'invalid request',
      issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    },
    400,
  );
}

/**
 * Run the standard auth + tenant + member guard for a GET route that accepts
 * `?memberId=<uuid>` as a query parameter. Returns the resolved context or an
 * early Response to return immediately.
 */
async function guardQuery(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
): Promise<
  | { db: Db; tenantId: string; memberId: string; caller: { id: string; role: string } }
  | { res: Response }
> {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) throw new Error('mw-weeks handler reached without userRow');
  const tenantId = c.get('tenantId') as string | undefined;
  if (!tenantId) {
    return { res: c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400) };
  }
  const parsed = memberQuerySchema.safeParse({ memberId: c.req.query('memberId') });
  if (!parsed.success) return { res: badRequest(c, parsed.error) };

  const db = getDb();
  const caller = await loadCaller(db, tenantId, userRow.id);
  if (!caller) {
    return { res: c.json({ error: 'forbidden', detail: 'caller is not a member' }, 403) };
  }
  if (!(await memberInTenant(db, tenantId, parsed.data.memberId))) {
    return { res: c.json({ error: 'not found', detail: 'member not found in this tenant' }, 404) };
  }
  if (!canManage(caller, parsed.data.memberId)) {
    return { res: c.json({ error: 'forbidden', detail: 'not allowed for this member' }, 403) };
  }
  return { db, tenantId, memberId: parsed.data.memberId, caller };
}

// ─── Week shape returned by GET / and GET /current ───────────────────────────

function toWeek(row: typeof mwWeeks.$inferSelect) {
  return {
    id: row.id,
    weekNumber: row.weekNumber,
    year: row.year,
    startDate: row.startDate,
    isFinalized: row.isFinalized,
    carriedOverStickers: row.carriedOverStickers,
    carriedOverCash: Number(row.carriedOverCash),
    retrievedStickers: row.retrievedStickers,
    retrievedCash: Number(row.retrievedCash),
  };
}

// ─── Router ──────────────────────────────────────────────────────────────────

export const mwWeeksRouter = new Hono()
  // GET / — all weeks for a member, ordered by startDate ascending.
  // Ensures the current week exists first so the list is never empty.
  .get('/', async (c) => {
    const ctx = await guardQuery(c);
    if ('res' in ctx) return ctx.res;
    const { db, tenantId, memberId } = ctx;

    const weeks = await loadWeeksForMember(db, tenantId, memberId);
    return c.json({ weeks });
  })

  // GET /current — get (or create) the current open week for a member.
  .get('/current', async (c) => {
    const ctx = await guardQuery(c);
    if ('res' in ctx) return ctx.res;
    const { db, tenantId, memberId } = ctx;

    const week = await getOrCreateCurrentWeek(db, tenantId, memberId);
    return c.json({ week: toWeek(week) });
  })

  // GET /:id/stats — sticker counts + cash value for a specific week.
  .get('/:id/stats', async (c) => {
    const ctx = await guardQuery(c);
    if ('res' in ctx) return ctx.res;
    const { db, tenantId, memberId } = ctx;
    const weekId = c.req.param('id');
    const stats = await loadWeekStats(db, tenantId, memberId, weekId);
    if (!stats) {
      return c.json({ error: 'not found', detail: 'week not found for this member' }, 404);
    }
    return c.json(stats);
  })

  // POST /:id/finalize — close a week (faithful port of the legacy flow).
  //
  // On close, all per (tenant, member) and inside one advisory-locked tx:
  //   1. snapshot the week (audit) before any mutation,
  //   2. auto-save this week's unallocated stickers from NON-invested habits
  //      into savings (invested-habit stickers are consumed by the investment),
  //   3. resolve active investments not in `continueInvestmentIds` — their
  //      matured value (sticker-first: max(0, principal + done*5 − missed*2))
  //      is returned to saved cash,
  //   4. mark the week finalized + store the closure snapshot,
  //   5. create the next ISO week,
  //   6. carry continued investments into the next week (matured value becomes
  //      the new principal; day counters reset; the original stake is kept).
  .post('/:id/finalize', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('mw-weeks finalize reached without userRow');
    const tenantId = c.get('tenantId') as string | undefined;
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = z
      .object({
        memberId: z.string().uuid(),
        continueInvestmentIds: z.array(z.string().uuid()).optional(),
      })
      .safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error);
    const { memberId } = parsed.data;
    const continueIds = parsed.data.continueInvestmentIds ?? [];
    const continueSet = new Set(continueIds);

    const db = getDb();
    const caller = await loadCaller(db, tenantId, userRow.id);
    if (!caller) return c.json({ error: 'forbidden', detail: 'caller is not a member' }, 403);
    if (!(await memberInTenant(db, tenantId, memberId))) {
      return c.json({ error: 'not found', detail: 'member not found in this tenant' }, 404);
    }
    if (!isAdmin(caller)) {
      return c.json(
        { error: 'forbidden', errorCode: 'ADMIN_ONLY', detail: 'only an admin can close a week' },
        403,
      );
    }

    const weekId = c.req.param('id');
    const now = new Date();
    // FHS-512 — resolved once per finalize call (child override, else the
    // family default); every cash figure this handler writes uses it.
    const rateMinor = await getEffectiveRateMinor(db, tenantId, memberId);
    const rate = rateMinorToDecimal(rateMinor);

    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${memberId}`}, 0))`,
      );

      // ── Load + guard the week (scoped to this child) ───────────────────────
      const [week] = await tx
        .select()
        .from(mwWeeks)
        .where(
          and(
            eq(mwWeeks.id, weekId),
            eq(mwWeeks.tenantId, tenantId),
            eq(mwWeeks.memberId, memberId),
          ),
        )
        .limit(1);
      if (!week) return { ok: false as const, code: 'NOT_FOUND' as const };
      if (week.isFinalized) return { ok: false as const, code: 'ALREADY' as const };

      // No earlier open week may exist (close them in order).
      const [earlier] = await tx
        .select({ weekNumber: mwWeeks.weekNumber, year: mwWeeks.year })
        .from(mwWeeks)
        .where(
          and(
            eq(mwWeeks.tenantId, tenantId),
            eq(mwWeeks.memberId, memberId),
            eq(mwWeeks.isFinalized, false),
            sql`(${mwWeeks.year} < ${week.year} OR (${mwWeeks.year} = ${week.year} AND ${mwWeeks.weekNumber} < ${week.weekNumber}))`,
          ),
        )
        .orderBy(asc(mwWeeks.year), asc(mwWeeks.weekNumber))
        .limit(1);
      if (earlier) {
        return { ok: false as const, code: 'EARLIER_OPEN' as const, earlier };
      }

      // Can't finalize a week that hasn't started yet.
      const cur = isoWeek(now);
      if (week.year > cur.year || (week.year === cur.year && week.weekNumber > cur.weekNumber)) {
        return { ok: false as const, code: 'FUTURE' as const, week };
      }

      // ── 1. Snapshot BEFORE mutations (audit) ───────────────────────────────
      const snapStickers = await tx
        .select({
          id: habitStickers.id,
          habitId: habitStickers.habitId,
          day: habitStickers.day,
          stickerValue: habitStickers.stickerValue,
          isAllocated: habitStickers.isAllocated,
        })
        .from(habitStickers)
        .where(
          and(
            eq(habitStickers.tenantId, tenantId),
            eq(habitStickers.memberId, memberId),
            eq(habitStickers.weekId, weekId),
          ),
        );
      const savingsBefore = await getOrCreateSavings(tx, tenantId, memberId);
      const activeInvestments = await tx
        .select()
        .from(mwInvestments)
        .where(
          and(
            eq(mwInvestments.tenantId, tenantId),
            eq(mwInvestments.memberId, memberId),
            eq(mwInvestments.isActive, true),
          ),
        );

      // continueInvestmentIds must all be active investments for this child.
      const activeIds = new Set(activeInvestments.map((i) => i.id));
      for (const id of continueIds) {
        if (!activeIds.has(id)) {
          return { ok: false as const, code: 'BAD_CONTINUE' as const, id };
        }
      }

      const totalStickerValue = snapStickers.reduce((s, r) => s + (r.stickerValue ?? 1), 0);
      const unallocatedValue = snapStickers
        .filter((s) => !s.isAllocated)
        .reduce((s, r) => s + (r.stickerValue ?? 1), 0);
      const closureSnapshot = {
        capturedAt: now.toISOString(),
        week: {
          id: weekId,
          weekNumber: week.weekNumber,
          year: week.year,
          startDate: week.startDate,
        },
        stickers: {
          total: snapStickers.length,
          totalValue: totalStickerValue,
          unallocatedValue,
          allocatedValue: totalStickerValue - unallocatedValue,
        },
        savings: { savedStickers: savingsBefore.savedStickers, savedCash: savingsBefore.savedCash },
        investments: activeInvestments.map((inv) => ({
          id: inv.id,
          habitId: inv.habitId,
          investedStickers: inv.investedStickers,
          currentValue: Number(inv.currentValue),
        })),
      };

      // ── 2. Auto-save unallocated stickers from non-invested habits ─────────
      const allUnalloc = snapStickers.filter((s) => !s.isAllocated);
      const investedHabitIds = new Set(activeInvestments.map((i) => i.habitId));
      const toSave = allUnalloc.filter((s) => !investedHabitIds.has(s.habitId));
      const stickerValue = toSave.reduce((s, r) => s + (r.stickerValue ?? 1), 0);

      if (allUnalloc.length > 0) {
        // Every unallocated sticker is now spent (invested ones are consumed
        // by the investment; the rest are banked).
        await tx
          .update(habitStickers)
          .set({ isAllocated: true })
          .where(
            and(
              eq(habitStickers.tenantId, tenantId),
              eq(habitStickers.memberId, memberId),
              eq(habitStickers.weekId, weekId),
              eq(habitStickers.isAllocated, false),
            ),
          );
      }
      if (stickerValue > 0) {
        const [txn] = await tx
          .insert(mwSavingsTransactions)
          .values({
            tenantId,
            memberId,
            transactionType: 'stickers',
            amount: String(stickerValue),
            stickerCount: stickerValue,
          })
          .returning({ id: mwSavingsTransactions.id });
        if (toSave.length > 0 && txn) {
          await tx
            .insert(mwTransactionStickers)
            .values(toSave.map((s) => ({ transactionId: txn.id, stickerId: s.id })));
        }
        await tx
          .update(mwSavings)
          .set({
            savedStickers: sql`${mwSavings.savedStickers} + ${stickerValue}`,
            updatedAt: now,
          })
          .where(and(eq(mwSavings.tenantId, tenantId), eq(mwSavings.memberId, memberId)));
        await tx.insert(mwWeekActions).values({
          tenantId,
          memberId,
          weekId,
          actionType: 'auto_save',
          stickersUsed: stickerValue,
          cashAmount: String(stickerValue * rate),
        });
      }

      // ── 2b. Skip-penalty accrual (FHS-512) — one negative money_adjustments
      // row per due day missed on a habit with skip_penalty_minor > 0, folded
      // straight into saved_cash. Runs after auto-save/before the finalized
      // flag flips, inside the same advisory lock + transaction.
      const skipPenalty = await applySkipPenalties(
        tx,
        tenantId,
        memberId,
        { id: weekId, startDate: week.startDate },
        now,
      );

      // ── 3+4. Mark finalized (a closed week is a "closed book": all 7 days
      // are past) and store the snapshot. ────────────────────────────────────
      await tx
        .update(mwWeeks)
        .set({ isFinalized: true, closureSnapshot, updatedAt: now })
        .where(
          and(
            eq(mwWeeks.id, weekId),
            eq(mwWeeks.tenantId, tenantId),
            eq(mwWeeks.memberId, memberId),
          ),
        );

      // ── Resolve / queue-continue active investments ────────────────────────
      type Cont = { id: string; habitId: string; valueStickers: number; valueCash: number };
      const toContinue: Cont[] = [];
      let investmentReturns = 0;

      for (const inv of activeInvestments) {
        // Recompute the matured value from THIS week's habit performance.
        const [cRow] = await tx
          .select({ n: count() })
          .from(habitStickers)
          .where(
            and(
              eq(habitStickers.tenantId, tenantId),
              eq(habitStickers.memberId, memberId),
              eq(habitStickers.habitId, inv.habitId),
              eq(habitStickers.weekId, weekId),
            ),
          );
        const completedDays = Math.min(cRow?.n ?? 0, 7);
        const missedDays = 7 - completedDays;
        // FHS-378 — honour the investment's deductible flag when maturing it.
        const { currentValueStickers, currentValueCash } = investmentValue(
          {
            investedStickers: inv.investedStickers,
            completedDays,
            missedDays,
            deductible: inv.deductible ?? true,
            dailyGain: inv.coefficient,
          },
          rate,
        );

        if (continueSet.has(inv.id)) {
          toContinue.push({
            id: inv.id,
            habitId: inv.habitId,
            valueStickers: currentValueStickers,
            valueCash: currentValueCash,
          });
        } else {
          await tx
            .update(mwInvestments)
            .set({
              isActive: false,
              isResolved: true,
              currentValue: String(currentValueCash),
              finalReturn: String(currentValueCash),
            })
            .where(
              and(
                eq(mwInvestments.id, inv.id),
                eq(mwInvestments.tenantId, tenantId),
                eq(mwInvestments.memberId, memberId),
              ),
            );
          investmentReturns += currentValueCash;
        }
      }

      if (investmentReturns > 0) {
        await tx
          .update(mwSavings)
          .set({
            savedCash: sql`${mwSavings.savedCash} + ${investmentReturns}`,
            updatedAt: now,
          })
          .where(and(eq(mwSavings.tenantId, tenantId), eq(mwSavings.memberId, memberId)));
      }

      // ── 5. Create the next ISO week ────────────────────────────────────────
      const [sy, sm, sd] = week.startDate.split('-').map((x) => Number.parseInt(x, 10));
      const nextMonday = mondayOf(new Date(Date.UTC(sy!, sm! - 1, sd! + 7)));
      const { weekNumber: nextWeekNumber, year: nextYear } = isoWeek(nextMonday);
      const nextStartDate = nextMonday.toISOString().slice(0, 10);

      const [existingNext] = await tx
        .select()
        .from(mwWeeks)
        .where(
          and(
            eq(mwWeeks.tenantId, tenantId),
            eq(mwWeeks.memberId, memberId),
            eq(mwWeeks.year, nextYear),
            eq(mwWeeks.weekNumber, nextWeekNumber),
          ),
        )
        .limit(1);

      let nextWeek = existingNext;
      if (!nextWeek) {
        const [created] = await tx
          .insert(mwWeeks)
          .values({
            tenantId,
            memberId,
            weekNumber: nextWeekNumber,
            year: nextYear,
            startDate: nextStartDate,
            carriedOverStickers: stickerValue,
          })
          .onConflictDoNothing()
          .returning();
        nextWeek = created ?? existingNext;
      } else {
        const [updated] = await tx
          .update(mwWeeks)
          .set({ carriedOverStickers: stickerValue, updatedAt: now })
          .where(
            and(
              eq(mwWeeks.id, nextWeek.id),
              eq(mwWeeks.tenantId, tenantId),
              eq(mwWeeks.memberId, memberId),
            ),
          )
          .returning();
        nextWeek = updated ?? nextWeek;
      }
      if (!nextWeek) throw new Error('finalize: failed to create or read the next week');

      // ── 6. Carry continued investments into the next week ──────────────────
      let continuedInvestments = 0;
      for (const cont of toContinue) {
        await tx
          .update(mwInvestments)
          .set({
            weekId: nextWeek.id,
            investedAmount: String(cont.valueCash),
            // matured value becomes the new working principal; the original
            // stake (original_invested_stickers) is intentionally left as-is.
            investedStickers: cont.valueStickers,
            currentValue: String(cont.valueCash),
            daysCompleted: 0,
            daysMissed: 0,
          })
          .where(
            and(
              eq(mwInvestments.id, cont.id),
              eq(mwInvestments.tenantId, tenantId),
              eq(mwInvestments.memberId, memberId),
            ),
          );
        const [habitRow] = await tx
          .select({ name: habits.name })
          .from(habits)
          .where(eq(habits.id, cont.habitId))
          .limit(1);
        await tx.insert(mwWeekActions).values({
          tenantId,
          memberId,
          weekId,
          actionType: 'invest_continue',
          stickersUsed: cont.valueStickers,
          cashAmount: String(cont.valueCash),
          habitId: cont.habitId,
          habitName: habitRow?.name ?? null,
        });
        continuedInvestments += 1;
      }

      return {
        ok: true as const,
        stickersAutoSaved: stickerValue,
        investmentReturns,
        continuedInvestments,
        skipPenaltyMinor: skipPenalty.totalPenaltyMinor,
        nextWeekId: nextWeek.id,
        nextWeekNumber: nextWeek.weekNumber,
        nextWeekYear: nextWeek.year,
      };
    });

    if (!outcome.ok) {
      switch (outcome.code) {
        case 'NOT_FOUND':
          return c.json({ error: 'not found', detail: 'week not found for this member' }, 404);
        case 'ALREADY':
          return c.json({ error: 'conflict', detail: 'week already finalized' }, 409);
        case 'EARLIER_OPEN':
          return c.json(
            {
              error: 'conflict',
              detail: `close earlier week ${outcome.earlier.weekNumber}/${outcome.earlier.year} first`,
            },
            409,
          );
        case 'FUTURE':
          return c.json({ error: 'conflict', detail: 'week has not started yet' }, 409);
        case 'BAD_CONTINUE':
          return c.json(
            { error: 'invalid request', detail: `investment ${outcome.id} is not active` },
            400,
          );
      }
      return c.json({ error: 'finalize failed' }, 500);
    }

    return c.json({
      finalized: true,
      stickersAutoSaved: outcome.stickersAutoSaved,
      investmentReturns: outcome.investmentReturns,
      continuedInvestments: outcome.continuedInvestments,
      skipPenaltyMinor: outcome.skipPenaltyMinor,
      nextWeekId: outcome.nextWeekId,
      nextWeekNumber: outcome.nextWeekNumber,
      nextWeekYear: outcome.nextWeekYear,
    });
  })

  // GET /:id/actions?memberId= — audit log of week actions for a child, newest first.
  .get('/:id/actions', async (c) => {
    const ctx = await guardQuery(c);
    if ('res' in ctx) return ctx.res;
    const { db, tenantId, memberId } = ctx;
    const weekId = c.req.param('id');
    // cash_amount is a Drizzle numeric → comes back as a string; loadWeekActions
    // coerces it to a number so the client can call .toFixed() on it (FHS-314).
    const actions = await loadWeekActions(db, tenantId, memberId, weekId);
    if (!actions) {
      return c.json({ error: 'not found', detail: 'week not found for this member' }, 404);
    }
    return c.json({ actions });
  })

  // PUT /:id/cash — admin-edit of carriedOverCash / retrievedCash on a week.
  .put('/:id/cash', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('mw-weeks cash reached without userRow');
    const tenantId = c.get('tenantId') as string | undefined;
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = z
      .object({
        memberId: z.string().uuid(),
        carriedOverCash: z.number().min(0).optional(),
        retrievedCash: z.number().min(0).optional(),
      })
      .safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error);
    const { memberId, carriedOverCash, retrievedCash } = parsed.data;

    const db = getDb();
    const caller = await loadCaller(db, tenantId, userRow.id);
    if (!caller) return c.json({ error: 'forbidden', detail: 'caller is not a member' }, 403);
    if (!(await memberInTenant(db, tenantId, memberId))) {
      return c.json({ error: 'not found', detail: 'member not found in this tenant' }, 404);
    }
    if (!isAdmin(caller)) {
      return c.json(
        { error: 'forbidden', errorCode: 'ADMIN_ONLY', detail: 'admin role required' },
        403,
      );
    }

    const weekId = c.req.param('id');
    const now = new Date();
    const patch: Record<string, unknown> = { updatedAt: now };
    if (carriedOverCash !== undefined) patch.carriedOverCash = String(carriedOverCash);
    if (retrievedCash !== undefined) patch.retrievedCash = String(retrievedCash);

    const [updated] = await db
      .update(mwWeeks)
      .set(patch)
      .where(
        and(eq(mwWeeks.id, weekId), eq(mwWeeks.tenantId, tenantId), eq(mwWeeks.memberId, memberId)),
      )
      .returning();

    if (!updated) {
      return c.json({ error: 'not found', detail: 'week not found for this member' }, 404);
    }
    return c.json({ week: toWeek(updated) });
  })

  // POST /:id/reopen — reverse a FINALIZED week's economy effects for a child.
  .post('/:id/reopen', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('mw-weeks reopen reached without userRow');
    const tenantId = c.get('tenantId') as string | undefined;
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = z.object({ memberId: z.string().uuid() }).safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error);
    const { memberId } = parsed.data;

    const db = getDb();
    const caller = await loadCaller(db, tenantId, userRow.id);
    if (!caller) return c.json({ error: 'forbidden', detail: 'caller is not a member' }, 403);
    if (!(await memberInTenant(db, tenantId, memberId))) {
      return c.json({ error: 'not found', detail: 'member not found in this tenant' }, 404);
    }
    if (!isAdmin(caller)) {
      return c.json(
        { error: 'forbidden', errorCode: 'ADMIN_ONLY', detail: 'admin role required' },
        403,
      );
    }

    const weekId = c.req.param('id');

    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${memberId}`}, 0))`,
      );

      const [week] = await tx
        .select()
        .from(mwWeeks)
        .where(
          and(
            eq(mwWeeks.id, weekId),
            eq(mwWeeks.tenantId, tenantId),
            eq(mwWeeks.memberId, memberId),
          ),
        )
        .limit(1);
      if (!week) return { ok: false as const, code: 'NOT_FOUND' as const };
      if (!week.isFinalized) return { ok: false as const, code: 'NOT_FINALIZED' as const };

      const reversal = await reverseFinalizationEffects(tx, tenantId, memberId, weekId, week);

      await tx
        .update(mwWeeks)
        .set({ isFinalized: false, updatedAt: new Date() })
        .where(
          and(
            eq(mwWeeks.id, weekId),
            eq(mwWeeks.tenantId, tenantId),
            eq(mwWeeks.memberId, memberId),
          ),
        );

      return { ok: true as const, reversal };
    });

    if (!outcome.ok) {
      if (outcome.code === 'NOT_FOUND') {
        return c.json({ error: 'not found', detail: 'week not found for this member' }, 404);
      }
      return c.json({ error: 'conflict', detail: 'week is not finalized' }, 409);
    }

    return c.json({
      reopened: true,
      weekId,
      reversal: outcome.reversal,
    });
  })

  // POST /:id/repair — reverse leftover finalization effects on an ACTIVE (non-finalized) week.
  .post('/:id/repair', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('mw-weeks repair reached without userRow');
    const tenantId = c.get('tenantId') as string | undefined;
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = z.object({ memberId: z.string().uuid() }).safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error);
    const { memberId } = parsed.data;

    const db = getDb();
    const caller = await loadCaller(db, tenantId, userRow.id);
    if (!caller) return c.json({ error: 'forbidden', detail: 'caller is not a member' }, 403);
    if (!(await memberInTenant(db, tenantId, memberId))) {
      return c.json({ error: 'not found', detail: 'member not found in this tenant' }, 404);
    }
    if (!isAdmin(caller)) {
      return c.json(
        { error: 'forbidden', errorCode: 'ADMIN_ONLY', detail: 'admin role required' },
        403,
      );
    }

    const weekId = c.req.param('id');

    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${memberId}`}, 0))`,
      );

      const [week] = await tx
        .select()
        .from(mwWeeks)
        .where(
          and(
            eq(mwWeeks.id, weekId),
            eq(mwWeeks.tenantId, tenantId),
            eq(mwWeeks.memberId, memberId),
          ),
        )
        .limit(1);
      if (!week) return { ok: false as const, code: 'NOT_FOUND' as const };
      // Repair only applies to non-finalized weeks (reopen handles finalized ones).
      if (week.isFinalized) return { ok: false as const, code: 'IS_FINALIZED' as const };

      const reversal = await reverseFinalizationEffects(tx, tenantId, memberId, weekId, week);
      return { ok: true as const, reversal };
    });

    if (!outcome.ok) {
      if (outcome.code === 'NOT_FOUND') {
        return c.json({ error: 'not found', detail: 'week not found for this member' }, 404);
      }
      return c.json({ error: 'conflict', detail: 'week is finalized — use reopen instead' }, 409);
    }

    return c.json({
      repaired: true,
      weekId,
      reversal: outcome.reversal,
    });
  });

// ─── Shared reversal helper ───────────────────────────────────────────────────
//
// Reverses the economy effects that POST /:id/finalize applied for one child:
//   1. Find auto_save week-actions for this week → locate their savings-transaction
//      rows via mw_transaction_stickers → un-allocate those habit_stickers →
//      subtract from mw_savings.saved_stickers → delete those transaction rows.
//   2. Find resolved investments in this week → restore them to active, subtract
//      their finalReturn from mw_savings.saved_cash.
//   3. Find invest_continue actions → move the continued investment back to this
//      week (best-effort — may be gone if already resolved).
//   4. Delete the auto_save / invest_continue week-action rows for this week.
//
// Called inside an advisory-locked transaction from both reopen and repair.

type TxHandle = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

async function reverseFinalizationEffects(
  tx: TxHandle,
  tenantId: string,
  memberId: string,
  weekId: string,
  week: { startDate: string },
): Promise<{
  stickersReversed: number;
  cashReversed: number;
  investmentsRestored: number;
  skipPenaltyReversedMinor: number;
}> {
  let stickersReversed = 0;
  let cashReversed = 0;
  let investmentsRestored = 0;
  const now = new Date();

  // ── 1. Reverse auto-saved stickers ───────────────────────────────────────
  // Find every mw_savings_transactions row that is linked (via mw_transaction_stickers)
  // to a habit_sticker in this week AND hasn't been reversed yet.
  const txRows = await tx
    .selectDistinct({
      id: mwSavingsTransactions.id,
      stickerCount: mwSavingsTransactions.stickerCount,
    })
    .from(mwSavingsTransactions)
    .innerJoin(
      mwTransactionStickers,
      eq(mwTransactionStickers.transactionId, mwSavingsTransactions.id),
    )
    .innerJoin(habitStickers, eq(habitStickers.id, mwTransactionStickers.stickerId))
    .where(
      and(
        eq(mwSavingsTransactions.tenantId, tenantId),
        eq(mwSavingsTransactions.memberId, memberId),
        eq(habitStickers.weekId, weekId),
        eq(mwSavingsTransactions.isReversed, false),
      ),
    );

  for (const { id: txId, stickerCount } of txRows) {
    // Un-allocate the stickers linked to this transaction.
    const stickerLinks = await tx
      .select({ stickerId: mwTransactionStickers.stickerId })
      .from(mwTransactionStickers)
      .where(eq(mwTransactionStickers.transactionId, txId));

    if (stickerLinks.length > 0) {
      const stickerIds = stickerLinks.map((r) => r.stickerId);
      await tx
        .update(habitStickers)
        .set({ isAllocated: false, updatedAt: now })
        .where(
          and(
            eq(habitStickers.tenantId, tenantId),
            eq(habitStickers.memberId, memberId),
            inArray(habitStickers.id, stickerIds),
          ),
        );
    }

    // Mark the transaction as reversed (don't delete — keep audit trail).
    await tx
      .update(mwSavingsTransactions)
      .set({ isReversed: true })
      .where(eq(mwSavingsTransactions.id, txId));

    stickersReversed += stickerCount;
  }

  if (stickersReversed > 0) {
    await tx
      .update(mwSavings)
      .set({
        savedStickers: sql`GREATEST(${mwSavings.savedStickers} - ${stickersReversed}, 0)`,
        updatedAt: now,
      })
      .where(and(eq(mwSavings.tenantId, tenantId), eq(mwSavings.memberId, memberId)));
  }

  // ── 2. Reverse resolved investments (those whose weekId is this week) ─────
  const resolvedInvs = await tx
    .select()
    .from(mwInvestments)
    .where(
      and(
        eq(mwInvestments.tenantId, tenantId),
        eq(mwInvestments.memberId, memberId),
        eq(mwInvestments.weekId, weekId),
        eq(mwInvestments.isResolved, true),
        eq(mwInvestments.isActive, false),
      ),
    );

  let totalCashToReverse = 0;
  for (const inv of resolvedInvs) {
    totalCashToReverse += Number(inv.finalReturn ?? 0);
    await tx
      .update(mwInvestments)
      .set({ isActive: true, isResolved: false, finalReturn: '0' })
      .where(
        and(
          eq(mwInvestments.id, inv.id),
          eq(mwInvestments.tenantId, tenantId),
          eq(mwInvestments.memberId, memberId),
        ),
      );
  }
  if (totalCashToReverse > 0) {
    await tx
      .update(mwSavings)
      .set({
        savedCash: sql`GREATEST(${mwSavings.savedCash} - ${totalCashToReverse}, 0)`,
        updatedAt: now,
      })
      .where(and(eq(mwSavings.tenantId, tenantId), eq(mwSavings.memberId, memberId)));
    cashReversed = totalCashToReverse;
    investmentsRestored = resolvedInvs.length;
  }

  // ── 3. Reverse continued investments (move back to this week) ────────────
  const continueActions = await tx
    .select()
    .from(mwWeekActions)
    .where(
      and(
        eq(mwWeekActions.tenantId, tenantId),
        eq(mwWeekActions.memberId, memberId),
        eq(mwWeekActions.weekId, weekId),
        eq(mwWeekActions.actionType, 'invest_continue'),
      ),
    );

  for (const action of continueActions) {
    if (!action.habitId) continue;
    // Find the active investment for this habit that is now in a different week.
    const [movedInv] = await tx
      .select({ id: mwInvestments.id })
      .from(mwInvestments)
      .where(
        and(
          eq(mwInvestments.tenantId, tenantId),
          eq(mwInvestments.memberId, memberId),
          eq(mwInvestments.habitId, action.habitId),
          eq(mwInvestments.isActive, true),
          sql`${mwInvestments.weekId} != ${weekId}`,
        ),
      )
      .limit(1);

    if (movedInv) {
      await tx
        .update(mwInvestments)
        .set({ weekId })
        .where(
          and(
            eq(mwInvestments.id, movedInv.id),
            eq(mwInvestments.tenantId, tenantId),
            eq(mwInvestments.memberId, memberId),
          ),
        );
    }
  }

  // ── 4. Delete the finalization-generated week-action rows ─────────────────
  await tx
    .delete(mwWeekActions)
    .where(
      and(
        eq(mwWeekActions.tenantId, tenantId),
        eq(mwWeekActions.memberId, memberId),
        eq(mwWeekActions.weekId, weekId),
        sql`${mwWeekActions.actionType} IN ('auto_save', 'invest_continue')`,
      ),
    );

  // ── 5. Reverse skip-penalty adjustments (FHS-512) ───────────────────────
  const skipPenaltyReversal = await reverseSkipPenalties(tx, tenantId, memberId, week, now);

  return {
    stickersReversed,
    cashReversed,
    investmentsRestored,
    skipPenaltyReversedMinor: skipPenaltyReversal.totalReversedMinor,
  };
}
