import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { members } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { memberInTenant } from '../lib/permissions.js';
import { loadRewardsForMember, redeemReward } from '../lib/myworld.js';

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
    return c.json(
      listRewardsResponseSchema.parse(
        await loadRewardsForMember(db, tenantId, parsed.data.memberId),
      ),
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
    // Redeem (advisory-locked spend) lives in lib/myworld.ts — shared with the
    // kid route so the money logic has exactly one home.
    const outcome = await redeemReward(db, {
      tenantId,
      memberId: parsed.data.memberId,
      rewardId,
    });
    if (!outcome.ok && outcome.reason === 'not-found') {
      return c.json({ error: 'not found', detail: 'reward not found in this tenant' }, 404);
    }
    if (!outcome.ok) {
      return c.json(
        {
          error: 'insufficient stickers',
          errorCode: 'INSUFFICIENT_STICKERS',
          detail: `needs ${outcome.cost}, has ${outcome.balance}`,
        },
        409,
      );
    }
    return c.json({ stickerBalance: outcome.balance, redemptionId: outcome.redemptionId }, 201);
  });
