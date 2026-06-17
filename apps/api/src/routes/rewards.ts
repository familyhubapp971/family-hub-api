import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  rewards,
  rewardRedemptions,
  habitStickers,
  mwSavings,
  mwWeekActions,
  members,
} from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { memberInTenant } from '../lib/permissions.js';
import {
  STICKER_TO_CASH,
  cashAsStickers,
  getOrCreateCurrentWeek,
  getOrCreateSavings,
  stickerBalance,
} from '../lib/myworld.js';

// FHS-268 / FHS-292 — GET /api/rewards, POST /api/rewards/:id/redeem.
//
// The kid Rewards Shop. GET returns the family's (non-archived) rewards
// plus the chosen member's sticker balance; POST spends stickers on a
// reward and records the redemption. Balance =
//   sum(habit_stickers.sticker_value) − sum(reward_redemptions.sticker_cost),
// shared with the habits route via lib/myworld.ts. Accessed by a parent
// viewing a child's world; memberId is validated against the tenant.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const rewardItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  stickerCost: z.number().int(),
  icon: z.string().nullable(),
});

export const listRewardsResponseSchema = z.object({
  rewards: z.array(rewardItemSchema),
  stickerBalance: z.number().int(),
});

const memberQuerySchema = z.object({ memberId: z.string().uuid() });
const redeemRequestSchema = z.object({ memberId: z.string().uuid() });

// The ChildWorld routes are parent-accessed: any member of the tenant
// (a parent/adult opening a child's world) may call them. Kid HS256
// tokens are blocked upstream by rejectKidTokens (FHS-257), so this only
// admits Supabase-session members. Tighten to a role check here if a
// kid-token path to these routes is ever added.
async function callerIsMember(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

export const rewardsRouter = new Hono()
  .get('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('rewards handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const parsed = memberQuerySchema.safeParse({ memberId: c.req.query('memberId') });
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const db = getDb();
    if (!(await callerIsMember(db, tenantId, userRow.id))) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    if (!(await memberInTenant(db, tenantId, parsed.data.memberId))) {
      return c.json({ error: 'not found', detail: 'member not found in this tenant' }, 404);
    }
    const [rewardRows, balance] = await Promise.all([
      db
        .select({
          id: rewards.id,
          name: rewards.name,
          description: rewards.description,
          stickerCost: rewards.stickerCost,
          icon: rewards.icon,
        })
        .from(rewards)
        .where(and(eq(rewards.tenantId, tenantId), isNull(rewards.archivedAt)))
        .orderBy(asc(rewards.stickerCost), asc(rewards.createdAt)),
      stickerBalance(db, tenantId, parsed.data.memberId),
    ]);
    return c.json(
      listRewardsResponseSchema.parse({ rewards: rewardRows, stickerBalance: balance }),
    );
  })
  .post('/:id/redeem', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('rewards handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const rewardId = c.req.param('id');
    if (!UUID_RE.test(rewardId)) {
      return c.json({ error: 'invalid id', detail: 'reward id must be a UUID' }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = redeemRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const db = getDb();
    if (!(await callerIsMember(db, tenantId, userRow.id))) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    if (!(await memberInTenant(db, tenantId, parsed.data.memberId))) {
      return c.json({ error: 'not found', detail: 'member not found in this tenant' }, 404);
    }
    const rewardRows = await db
      .select({ id: rewards.id, stickerCost: rewards.stickerCost, name: rewards.name })
      .from(rewards)
      .where(
        and(eq(rewards.tenantId, tenantId), eq(rewards.id, rewardId), isNull(rewards.archivedAt)),
      )
      .limit(1);
    const reward = rewardRows[0];
    if (!reward) {
      return c.json({ error: 'not found', detail: 'reward not found in this tenant' }, 404);
    }
    const memberId = parsed.data.memberId;
    const cost = reward.stickerCost;
    // Claim (ported from legacy): serialize per (tenant, member) with an
    // advisory lock, then spend in order — banked stickers, then saved cash,
    // then this week's unallocated stickers (marked allocated). Records a
    // 'claim' week_action. A concurrent claim waits, re-reads, and 409s.
    const week = await getOrCreateCurrentWeek(db, tenantId, memberId);
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${memberId}`}, 0))`,
      );
      const savings = await getOrCreateSavings(tx, tenantId, memberId);
      const unallocated = await tx
        .select({
          id: habitStickers.id,
          value: habitStickers.stickerValue,
        })
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
      if (balance < cost) return { ok: false as const, balance };

      let need = cost;
      const fromSavedStickers = Math.min(need, savings.savedStickers);
      need -= fromSavedStickers;
      const fromSavedCash = Math.min(need, cashStk);
      need -= fromSavedCash;
      // Remainder from this week's stickers — mark rows allocated until
      // their cumulative value covers `need` (smallest first).
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
      // History (kept for audit; balance no longer reads this table).
      await tx
        .insert(rewardRedemptions)
        .values({ tenantId, rewardId, memberId, stickerCost: cost });
      return { ok: true as const, balance: balance - cost, id: action!.id };
    });
    if (!outcome.ok) {
      return c.json(
        {
          error: 'insufficient stickers',
          errorCode: 'INSUFFICIENT_STICKERS',
          detail: `needs ${cost}, has ${outcome.balance}`,
        },
        409,
      );
    }
    return c.json({ stickerBalance: outcome.balance, redemptionId: outcome.id }, 201);
  });
