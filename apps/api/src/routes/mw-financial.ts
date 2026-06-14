import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  habitStickers,
  members,
  mwSavings,
  mwSavingsTransactions,
  mwTransactionStickers,
  mwWeekActions,
} from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import {
  STICKER_TO_CASH,
  getOrCreateCurrentWeek,
  getOrCreateSavings,
  getSavings,
  getTenantCurrency,
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

async function loadCaller(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  userId: string,
): Promise<{ id: string; role: string } | null> {
  const rows = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}
function canManage(caller: { id: string; role: string }, memberId: string): boolean {
  return caller.id === memberId || caller.role === 'admin' || caller.role === 'adult';
}
async function memberInTenant(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  memberId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.id, memberId)))
    .limit(1);
  return rows.length > 0;
}
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
    const [savings, currency] = await Promise.all([
      getSavings(g.db, g.tenantId, parsed.data.memberId),
      getTenantCurrency(g.db, g.tenantId),
    ]);
    return c.json({
      savedStickers: savings.savedStickers,
      savedCash: savings.savedCash,
      currency,
    });
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
