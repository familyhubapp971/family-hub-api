import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, count, eq, inArray, lt, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  habits,
  habitStickers,
  members,
  mwInvestments,
  mwSavings,
  mwSavingsTransactions,
  mwTransactionStickers,
  mwWeekActions,
  mwWeeks,
} from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { loadCaller, canManage, memberInTenant } from '../lib/permissions.js';
import {
  cashAsStickers,
  elapsedDaysForWeek,
  INVEST_MIN_STICKERS,
  investmentValue,
  loadInvestmentsForMember,
  loadSavingsForMember,
  STICKER_TO_CASH,
  getOrCreateCurrentWeek,
  getOrCreateSavings,
} from '../lib/myworld.js';

// FHS-295 — My World savings / banking.
//
// Ported from legacy family-hub: a child banks this week's unallocated
// stickers into savings (as stickers, or as cash at 0.5 each), and can
// cash out from combined savings (cash first, then stickers). Every action
// is recorded as a mw_week_action; saved stickers are marked allocated +
// linked to the save transaction. Parent-accessed; per (tenant, member).

const memberQuerySchema = z.object({ memberId: z.string().uuid() });
const saveSchema = z.object({
  memberId: z.string().uuid(),
  type: z.enum(['stickers', 'cash']),
  amount: z.number().positive(),
});
const cashoutSchema = z.object({
  memberId: z.string().uuid(),
  amount: z.number().positive(),
});

async function guard(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  member: string,
): Promise<{ db: ReturnType<typeof getDb>; tenantId: string } | { res: Response }> {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) throw new Error('financial handler reached without userRow');
  const tenantId = c.get('tenantId');
  if (!tenantId) {
    return { res: c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400) };
  }
  const db = getDb();
  const caller = await loadCaller(db, tenantId, userRow.id);
  if (!caller)
    return { res: c.json({ error: 'forbidden', detail: 'caller is not a member' }, 403) };
  if (!(await memberInTenant(db, tenantId, member))) {
    return { res: c.json({ error: 'not found', detail: 'member not found in this tenant' }, 404) };
  }
  if (!canManage(caller, member)) {
    return { res: c.json({ error: 'forbidden', detail: 'not allowed for this member' }, 403) };
  }
  return { db, tenantId };
}

export const mwFinancialRouter = new Hono()
  // Read the child's banked savings + family currency.
  .get('/savings', async (c) => {
    const parsed = memberQuerySchema.safeParse({ memberId: c.req.query('memberId') });
    if (!parsed.success) {
      return c.json({ error: 'invalid request', detail: 'memberId (uuid) required' }, 400);
    }
    const g = await guard(c, parsed.data.memberId);
    if ('res' in g) return g.res;
    return c.json(await loadSavingsForMember(g.db, g.tenantId, parsed.data.memberId));
  })
  // Bank this week's unallocated stickers into savings (as stickers or cash).
  .post('/savings', async (c) => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = saveSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const { memberId, type, amount } = parsed.data;
    const g = await guard(c, memberId);
    if ('res' in g) return g.res;
    const { db, tenantId } = g;
    const week = await getOrCreateCurrentWeek(db, tenantId, memberId);
    // stickers to draw from this week (cash save converts at 0.5).
    const stickersNeeded = type === 'cash' ? Math.ceil(amount / STICKER_TO_CASH) : amount;

    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${memberId}`}, 0))`,
      );
      await getOrCreateSavings(tx, tenantId, memberId);
      const unallocated = await tx
        .select({ id: habitStickers.id, value: habitStickers.stickerValue })
        .from(habitStickers)
        .where(
          and(
            eq(habitStickers.tenantId, tenantId),
            eq(habitStickers.memberId, memberId),
            eq(habitStickers.weekId, week.id),
            eq(habitStickers.isAllocated, false),
          ),
        )
        .orderBy(asc(habitStickers.stickerValue));
      const available = unallocated.reduce((s, r) => s + r.value, 0);
      // Save only draws from this week's stickers (not savings).
      if (stickersNeeded > available) return { ok: false as const, available };

      const allocateIds: string[] = [];
      // `covered` is the ACTUAL sticker-value banked (a bonus sticker is
      // worth 5). We credit savings by `covered`, not the requested amount,
      // so a value-5 sticker spent on a 1-sticker save banks the full 5 —
      // no value is destroyed (conserves the economy).
      let covered = 0;
      for (const r of unallocated) {
        if (covered >= stickersNeeded) break;
        allocateIds.push(r.id);
        covered += r.value;
      }
      await tx
        .update(habitStickers)
        .set({ isAllocated: true })
        .where(
          and(
            eq(habitStickers.tenantId, tenantId),
            eq(habitStickers.memberId, memberId),
            eq(habitStickers.isAllocated, false),
            inArray(habitStickers.id, allocateIds),
          ),
        );
      const bankedStickers = type === 'stickers' ? covered : 0;
      const bankedCash = type === 'cash' ? covered * STICKER_TO_CASH : 0;
      const [txnRow] = await tx
        .insert(mwSavingsTransactions)
        .values({
          tenantId,
          memberId,
          transactionType: type,
          amount: String(type === 'cash' ? bankedCash : covered),
          stickerCount: covered,
        })
        .returning({ id: mwSavingsTransactions.id });
      if (allocateIds.length > 0) {
        await tx
          .insert(mwTransactionStickers)
          .values(allocateIds.map((stickerId) => ({ transactionId: txnRow!.id, stickerId })));
      }
      if (type === 'stickers') {
        await tx
          .update(mwSavings)
          .set({
            savedStickers: sql`${mwSavings.savedStickers} + ${bankedStickers}`,
            updatedAt: new Date(),
          })
          .where(and(eq(mwSavings.tenantId, tenantId), eq(mwSavings.memberId, memberId)));
      } else {
        await tx
          .update(mwSavings)
          .set({ savedCash: sql`${mwSavings.savedCash} + ${bankedCash}`, updatedAt: new Date() })
          .where(and(eq(mwSavings.tenantId, tenantId), eq(mwSavings.memberId, memberId)));
      }
      await tx.insert(mwWeekActions).values({
        tenantId,
        memberId,
        weekId: week.id,
        actionType: 'save',
        stickersUsed: covered,
        cashAmount: type === 'cash' ? String(bankedCash) : null,
      });
      return { ok: true as const, transactionId: txnRow!.id };
    });
    if (!outcome.ok) {
      return c.json(
        {
          error: 'not enough weekly stickers',
          errorCode: 'INSUFFICIENT_STICKERS',
          available: outcome.available,
        },
        409,
      );
    }
    return c.json({ success: true, transactionId: outcome.transactionId }, 201);
  })
  // ── INVESTMENTS (FHS-296) ──────────────────────────────────────────────────
  //
  // Ported from legacy family-hub. Three routes:
  //   GET  /investments?memberId=  — active investments for this child
  //   POST /investments            — create a new investment
  //   POST /investments/:id/withdraw — full or partial withdrawal
  //
  // All are per (tenant, member) and gate through the same `guard` helper used
  // by savings/cashout above. Create + withdraw run inside an advisory-locked
  // transaction so concurrent requests can't double-spend stickers.

  // GET active investments. For each one, recalculates value on the fly
  // (completed days from habit_stickers, missed days from elapsed time) and
  // returns it. This is a read-only path — it does NOT persist the recomputed
  // values, so it can't race a concurrent withdraw and clobber its principal
  // update. The authoritative state is owned by the create/withdraw paths,
  // and value is always derived, never trusted from the stored cache.
  .get('/investments', async (c) => {
    const parsed = memberQuerySchema.safeParse({ memberId: c.req.query('memberId') });
    if (!parsed.success) {
      return c.json({ error: 'invalid request', detail: 'memberId (uuid) required' }, 400);
    }
    const g = await guard(c, parsed.data.memberId);
    if ('res' in g) return g.res;
    return c.json(await loadInvestmentsForMember(g.db, g.tenantId, parsed.data.memberId));
  })

  // POST create investment. Checks availability (savings-first), allocates
  // stickers, inserts the investment row, and records a week action.
  .post('/investments', async (c) => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = z
      .object({
        memberId: z.string().uuid(),
        habitId: z.string().uuid(),
        stickerCount: z
          .number()
          .int()
          .min(INVEST_MIN_STICKERS, {
            message: `Minimum ${INVEST_MIN_STICKERS} stickers required to invest`,
          }),
      })
      .safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const { memberId, habitId, stickerCount } = parsed.data;
    const g = await guard(c, memberId);
    if ('res' in g) return g.res;
    const { db, tenantId } = g;

    // Verify the habit exists in this tenant AND belongs to this member.
    // (FIX 1: scope to memberId so child A cannot invest in child B's habit)
    const habitRows = await db
      .select({ id: habits.id, name: habits.name })
      .from(habits)
      .where(
        and(eq(habits.tenantId, tenantId), eq(habits.memberId, memberId), eq(habits.id, habitId)),
      )
      .limit(1);
    if (!habitRows[0]) {
      return c.json({ error: 'not found', detail: 'habit not found for this member' }, 404);
    }
    const habitName = habitRows[0].name;

    const week = await getOrCreateCurrentWeek(db, tenantId, memberId);

    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${memberId}`}, 0))`,
      );

      // FIX 3: duplicate-active check moved inside the advisory-locked tx so
      // two concurrent requests on the same habit both see the same state.
      const existingRows = await tx
        .select({ id: mwInvestments.id })
        .from(mwInvestments)
        .where(
          and(
            eq(mwInvestments.tenantId, tenantId),
            eq(mwInvestments.memberId, memberId),
            eq(mwInvestments.habitId, habitId),
            eq(mwInvestments.isActive, true),
          ),
        )
        .limit(1);
      if (existingRows[0]) {
        return {
          ok: false as const,
          conflict: true as const,
        };
      }

      const s = await getOrCreateSavings(tx, tenantId, memberId);

      // Available = unallocated week sticker value + saved stickers + cash-as-stickers.
      const unallocated = await tx
        .select({ id: habitStickers.id, value: habitStickers.stickerValue })
        .from(habitStickers)
        .where(
          and(
            eq(habitStickers.tenantId, tenantId),
            eq(habitStickers.memberId, memberId),
            eq(habitStickers.weekId, week.id),
            eq(habitStickers.isAllocated, false),
          ),
        )
        .orderBy(asc(habitStickers.stickerValue));
      const weekValue = unallocated.reduce((acc, r) => acc + r.value, 0);
      const available = weekValue + s.savedStickers + cashAsStickers(s.savedCash);

      if (stickerCount > available) {
        return { ok: false as const, conflict: false as const, available };
      }

      // Allocate savings-first: savedStickers → savedCash → week stickers.
      let remaining = stickerCount;

      if (remaining > 0 && s.savedStickers > 0) {
        const fromStickers = Math.min(remaining, s.savedStickers);
        await tx
          .update(mwSavings)
          .set({
            savedStickers: sql`${mwSavings.savedStickers} - ${fromStickers}`,
            updatedAt: new Date(),
          })
          .where(and(eq(mwSavings.tenantId, tenantId), eq(mwSavings.memberId, memberId)));
        remaining -= fromStickers;
      }

      if (remaining > 0 && s.savedCash > 0) {
        const fromCashStickers = Math.min(remaining, cashAsStickers(s.savedCash));
        const cashToDeduct = fromCashStickers * STICKER_TO_CASH;
        await tx
          .update(mwSavings)
          .set({ savedCash: sql`${mwSavings.savedCash} - ${cashToDeduct}`, updatedAt: new Date() })
          .where(and(eq(mwSavings.tenantId, tenantId), eq(mwSavings.memberId, memberId)));
        remaining -= fromCashStickers;
      }

      if (remaining > 0) {
        // Mark week stickers as allocated (smallest value first).
        const allocateIds: string[] = [];
        let covered = 0;
        for (const r of unallocated) {
          if (covered >= remaining) break;
          allocateIds.push(r.id);
          covered += r.value;
        }
        if (allocateIds.length > 0) {
          await tx
            .update(habitStickers)
            .set({ isAllocated: true })
            .where(
              and(
                eq(habitStickers.tenantId, tenantId),
                eq(habitStickers.memberId, memberId),
                eq(habitStickers.isAllocated, false),
                inArray(habitStickers.id, allocateIds),
              ),
            );
        }
      }

      const [investment] = await tx
        .insert(mwInvestments)
        .values({
          tenantId,
          memberId,
          habitId,
          weekId: week.id,
          investedStickers: stickerCount,
          originalInvestedStickers: stickerCount,
          investedAmount: String(stickerCount * STICKER_TO_CASH),
          currentValue: String(stickerCount * STICKER_TO_CASH),
          daysCompleted: 0,
          daysMissed: 0,
          isActive: true,
          isResolved: false,
        })
        .returning();

      await tx.insert(mwWeekActions).values({
        tenantId,
        memberId,
        weekId: week.id,
        actionType: 'invest',
        stickersUsed: stickerCount,
        habitId,
        habitName,
        cashAmount: String(stickerCount * STICKER_TO_CASH),
      });

      return { ok: true as const, investment };
    });

    if (!outcome.ok) {
      if (outcome.conflict) {
        return c.json(
          {
            error: 'conflict',
            errorCode: 'ACTIVE_INVESTMENT_EXISTS',
            detail: 'an active investment for this habit already exists',
          },
          409,
        );
      }
      return c.json(
        {
          error: 'not enough stickers',
          errorCode: 'INSUFFICIENT_STICKERS',
          available: outcome.available,
        },
        409,
      );
    }
    return c.json(outcome.investment, 201);
  })

  // POST withdraw from an active investment (full or partial).
  .post('/investments/:id/withdraw', async (c) => {
    const investmentId = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = z
      .object({
        memberId: z.string().uuid(),
        stickers: z.number().int().min(1).optional(),
      })
      .safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const { memberId, stickers: requestedStickers } = parsed.data;
    const g = await guard(c, memberId);
    if ('res' in g) return g.res;
    const { db, tenantId } = g;
    const now = new Date();

    // Everything that decides the payout — re-reading the investment, recomputing
    // its current value, and the limit check — happens INSIDE the advisory lock.
    // If the value + limit check ran before the lock (as they used to), two
    // concurrent withdraws could both pass against a stale, higher value and
    // double-spend. Re-reading the row with isActive=true inside the lock also
    // makes a second (already-resolved) withdraw 404 instead of paying out twice.
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${memberId}`}, 0))`,
      );

      const invRows = await tx
        .select()
        .from(mwInvestments)
        .where(
          and(
            eq(mwInvestments.tenantId, tenantId),
            eq(mwInvestments.memberId, memberId),
            eq(mwInvestments.id, investmentId),
            eq(mwInvestments.isActive, true),
          ),
        )
        .limit(1);
      if (!invRows[0]) return { ok: false as const, notFound: true as const };
      const inv = invRows[0];

      // Habit name for the week-action label.
      const habitRows = await tx
        .select({ name: habits.name })
        .from(habits)
        .where(eq(habits.id, inv.habitId))
        .limit(1);
      const habitName = habitRows[0]?.name ?? null;

      // Recompute current value from week elapsed + placed stickers.
      const weekRows = await tx
        .select({ isFinalized: mwWeeks.isFinalized, startDate: mwWeeks.startDate })
        .from(mwWeeks)
        .where(eq(mwWeeks.id, inv.weekId))
        .limit(1);
      const week = weekRows[0];
      const elapsed = week
        ? elapsedDaysForWeek({ isFinalized: week.isFinalized, startDate: week.startDate }, now)
        : 0;

      const [completedRow] = await tx
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
      // completedDays = every sticker placed this week (legacy); only the
      // missed penalty below uses elapsed days.
      const completedDays = completedRow?.n ?? 0;

      const [pastRow] = await tx
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
      const stickersOnPastDays = pastRow?.n ?? 0;
      const missedDays = Math.max(0, elapsed - stickersOnPastDays);

      const { currentValueStickers } = investmentValue({
        investedStickers: inv.investedStickers,
        completedDays,
        missedDays,
      });

      const total = currentValueStickers;
      if (requestedStickers !== undefined && requestedStickers > total) {
        return { ok: false as const, overLimit: true as const, available: total };
      }
      const toWithdraw = requestedStickers ?? total;
      const isPartial = toWithdraw < total;

      // Credit savedStickers.
      await tx
        .update(mwSavings)
        .set({
          savedStickers: sql`${mwSavings.savedStickers} + ${toWithdraw}`,
          updatedAt: new Date(),
        })
        .where(and(eq(mwSavings.tenantId, tenantId), eq(mwSavings.memberId, memberId)));

      if (isPartial) {
        // Reduce the PRINCIPAL by the withdrawn amount. Current value is
        // re-derived as max(0, principal + completed*5 - missed*2) on every
        // read, so when growth pushed value above the original stake the
        // principal can legitimately go negative — that keeps the formula equal
        // to the true remaining value. Do NOT clamp it to 0: that would re-add
        // the withdrawn growth for free on the next recalc.
        const newPrincipal = inv.investedStickers - toWithdraw;
        await tx
          .update(mwInvestments)
          .set({
            investedStickers: newPrincipal,
            currentValue: String((currentValueStickers - toWithdraw) * STICKER_TO_CASH),
          })
          .where(
            and(
              eq(mwInvestments.id, investmentId),
              eq(mwInvestments.tenantId, tenantId),
              eq(mwInvestments.memberId, memberId),
            ),
          );
      } else {
        await tx
          .update(mwInvestments)
          .set({
            isActive: false,
            isResolved: true,
            finalReturn: String(toWithdraw * STICKER_TO_CASH),
          })
          .where(
            and(
              eq(mwInvestments.id, investmentId),
              eq(mwInvestments.tenantId, tenantId),
              eq(mwInvestments.memberId, memberId),
            ),
          );
      }

      const currentWeek = await getOrCreateCurrentWeek(tx, tenantId, memberId, now);
      await tx.insert(mwWeekActions).values({
        tenantId,
        memberId,
        weekId: currentWeek.id,
        actionType: 'withdraw',
        stickersUsed: toWithdraw,
        habitId: inv.habitId,
        habitName,
        cashAmount: String(toWithdraw * STICKER_TO_CASH),
      });

      return { ok: true as const, toWithdraw, remaining: total - toWithdraw };
    });

    if (!outcome.ok) {
      if (outcome.notFound) {
        return c.json({ error: 'not found', detail: 'investment not found or not active' }, 404);
      }
      return c.json(
        { error: 'cannot withdraw more stickers than available', available: outcome.available },
        400,
      );
    }

    return c.json({
      success: true,
      withdrawnStickers: outcome.toWithdraw,
      remainingStickers: outcome.remaining,
    });
  })

  // PUT /savings/admin-set — overwrite a child's savings balance (admin only, FHS-335).
  // Used by the Admin Panel to manually correct a child's sticker/cash balance.
  .put('/savings/admin-set', async (c) => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = z
      .object({
        memberId: z.string().uuid(),
        savedStickers: z.number().int().min(0),
        savedCash: z.number().min(0),
      })
      .safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const { memberId, savedStickers, savedCash } = parsed.data;
    const g = await guard(c, memberId);
    if ('res' in g) return g.res;
    const { db, tenantId } = g;

    // FHS-335 — manually rewriting a balance is admin-only (not "can manage"
    // which includes self, and no longer a non-admin adult).
    const userRow = c.get('userRow') as { id: string } | undefined;
    if (!userRow) throw new Error('financial/admin-set reached without userRow');
    const callerRow = await db
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.tenantId, tenantId), eq(members.userId, userRow.id)))
      .limit(1);
    if (callerRow[0]?.role !== 'admin') {
      return c.json(
        { error: 'forbidden', errorCode: 'ADMIN_ONLY', detail: 'admin role required' },
        403,
      );
    }

    const now = new Date();
    // Ensure the savings row exists.
    await getOrCreateSavings(db, tenantId, memberId);
    const [updated] = await db
      .update(mwSavings)
      .set({ savedStickers, savedCash: String(savedCash), updatedAt: now })
      .where(and(eq(mwSavings.tenantId, tenantId), eq(mwSavings.memberId, memberId)))
      .returning();

    return c.json({
      savedStickers: updated?.savedStickers ?? savedStickers,
      savedCash: Number(updated?.savedCash ?? savedCash),
    });
  })

  // Cash out from combined savings (cash first, then saved stickers).
  .post('/savings/cashout', async (c) => {
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = cashoutSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const { memberId, amount } = parsed.data;
    const g = await guard(c, memberId);
    if ('res' in g) return g.res;
    const { db, tenantId } = g;
    const week = await getOrCreateCurrentWeek(db, tenantId, memberId);
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${memberId}`}, 0))`,
      );
      const s = await getOrCreateSavings(tx, tenantId, memberId);
      const totalAvailable = s.savedCash + s.savedStickers * STICKER_TO_CASH;
      if (amount > totalAvailable) return { ok: false as const, totalAvailable };
      let remaining = amount;
      const cashDeducted = Math.min(remaining, s.savedCash);
      remaining -= cashDeducted;
      let stickersDeducted = 0;
      let refundCash = 0;
      if (remaining > 0 && s.savedStickers > 0) {
        // Stickers come in 0.5 units; if the remainder isn't a whole
        // multiple, the rounded-up sticker over-delivers — refund that
        // surplus back to saved cash so no value is destroyed.
        stickersDeducted = Math.min(Math.ceil(remaining / STICKER_TO_CASH), s.savedStickers);
        refundCash = stickersDeducted * STICKER_TO_CASH - remaining;
        remaining = 0;
      }
      await tx
        .update(mwSavings)
        .set({
          savedCash: sql`${mwSavings.savedCash} - ${cashDeducted} + ${refundCash}`,
          savedStickers: sql`${mwSavings.savedStickers} - ${stickersDeducted}`,
          updatedAt: new Date(),
        })
        .where(and(eq(mwSavings.tenantId, tenantId), eq(mwSavings.memberId, memberId)));
      await tx.insert(mwWeekActions).values({
        tenantId,
        memberId,
        weekId: week.id,
        actionType: 'cashout',
        cashAmount: String(amount),
        stickersUsed: stickersDeducted,
      });
      return { ok: true as const, cashDeducted, stickersDeducted };
    });
    if (!outcome.ok) {
      return c.json(
        {
          error: 'not enough savings',
          errorCode: 'INSUFFICIENT_SAVINGS',
          available: outcome.totalAvailable,
        },
        409,
      );
    }
    return c.json(
      {
        success: true,
        cashDeducted: outcome.cashDeducted,
        stickersDeducted: outcome.stickersDeducted,
      },
      201,
    );
  });
