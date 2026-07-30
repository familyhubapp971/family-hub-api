import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { members, rewards, type Reward } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { loadCaller, isAdmin, memberInTenant } from '../lib/permissions.js';
import { loadRewardsForMember, redeemReward } from '../lib/myworld.js';

// FHS-268 / FHS-292 — GET /api/rewards, POST /api/rewards/:id/redeem.
//
// The kid Rewards Shop. GET returns the family's (non-archived) rewards
// plus the chosen member's sticker balance; POST spends stickers on a
// reward and records the redemption. Balance =
//   sum(habit_stickers.sticker_value) − sum(reward_redemptions.sticker_cost),
// shared with the habits route via lib/myworld.ts. Accessed by a parent
// viewing a child's world; memberId is validated against the tenant.
//
// FHS-483 — POST/PATCH/DELETE /api/rewards[/:id]: parents manage the reward
// shop's catalogue (create/edit/archive a reward). Admin-only, tenant-scoped,
// same guard chain as apps/api/src/routes/admin.ts: authenticated user →
// tenant context (400 if missing) → caller is a tenant member (403) → caller
// is admin (403). DELETE is a SOFT delete (sets archived_at) — never a hard
// DELETE — because reward_redemptions and redemption_requests both hold a
// foreign key to a reward's id; hard-deleting would cascade-erase a family's
// redemption history. Archived rewards already drop out of the kid shop via
// loadRewardsForMember's `isNull(archivedAt)` filter.

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

// FHS-483 — create/update payloads for the parent-managed reward catalogue.
// description/icon use `.nullish()` so a PATCH can explicitly clear a field
// by sending `null`, while an omitted key leaves it untouched.
export const createRewardRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullish(),
  stickerCost: z.number().int().min(1),
  icon: z.string().trim().max(40).nullish(),
});

export const updateRewardRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullish(),
  stickerCost: z.number().int().min(1).optional(),
  icon: z.string().trim().max(40).nullish(),
});

function toRewardItem(row: Reward) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    stickerCost: row.stickerCost,
    icon: row.icon,
  };
}

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

// FHS-483 — guard chain for the admin-only reward-management endpoints.
// Mirrors apps/api/src/routes/admin.ts's guardTenant + isAdmin check
// EXACTLY: authenticated user → tenant context (400 TENANT_REQUIRED) →
// caller is a tenant member (403) → caller is admin (403 ADMIN_ONLY).
// Tenant always comes from request context, never the body.
async function guardAdmin(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
): Promise<
  | { db: ReturnType<typeof getDb>; tenantId: string; caller: { id: string; role: string } }
  | { res: Response }
> {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) throw new Error('rewards handler reached without userRow');
  const tenantId = c.get('tenantId') as string | undefined;
  if (!tenantId) {
    return { res: c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400) };
  }
  const db = getDb();
  const caller = await loadCaller(db, tenantId, userRow.id);
  if (!caller) {
    return { res: c.json({ error: 'forbidden', detail: 'caller is not a member' }, 403) };
  }
  if (!isAdmin(caller)) {
    return {
      res: c.json(
        { error: 'forbidden', errorCode: 'ADMIN_ONLY', detail: 'admin role required' },
        403,
      ),
    };
  }
  return { db, tenantId, caller };
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
  })
  // FHS-483 — create a reward. Admin-only.
  .post('/', async (c) => {
    const ctx = await guardAdmin(c);
    if ('res' in ctx) return ctx.res;
    const { db, tenantId } = ctx;
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = createRewardRequestSchema.safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error);
    const [row] = await db
      .insert(rewards)
      .values({
        tenantId,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        stickerCost: parsed.data.stickerCost,
        icon: parsed.data.icon ?? null,
      })
      .returning();
    return c.json(rewardItemSchema.parse(toRewardItem(row!)), 201);
  })
  // FHS-483 — partial update of a reward's name/description/stickerCost/icon.
  // Admin-only; scoped to the caller's tenant so a reward id from another
  // family can never be edited (defence-in-depth on top of RLS).
  .patch('/:id', async (c) => {
    const ctx = await guardAdmin(c);
    if ('res' in ctx) return ctx.res;
    const { db, tenantId } = ctx;
    const rewardId = c.req.param('id');
    if (!UUID_RE.test(rewardId)) {
      return c.json({ error: 'invalid id', detail: 'reward id must be a UUID' }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = updateRewardRequestSchema.safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.stickerCost !== undefined) patch.stickerCost = parsed.data.stickerCost;
    if (parsed.data.icon !== undefined) patch.icon = parsed.data.icon;
    const [row] = await db
      .update(rewards)
      .set(patch)
      .where(and(eq(rewards.tenantId, tenantId), eq(rewards.id, rewardId)))
      .returning();
    if (!row) return c.json({ error: 'not found', detail: 'reward not found in this tenant' }, 404);
    return c.json(rewardItemSchema.parse(toRewardItem(row)));
  })
  // FHS-483 — archive (soft-delete) a reward. Admin-only, tenant-scoped, 404
  // if the reward isn't in the caller's tenant or is already archived. See
  // the top-of-file note on why this never hard-deletes the row.
  .delete('/:id', async (c) => {
    const ctx = await guardAdmin(c);
    if ('res' in ctx) return ctx.res;
    const { db, tenantId } = ctx;
    const rewardId = c.req.param('id');
    if (!UUID_RE.test(rewardId)) {
      return c.json({ error: 'invalid id', detail: 'reward id must be a UUID' }, 400);
    }
    const [row] = await db
      .update(rewards)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(rewards.tenantId, tenantId), eq(rewards.id, rewardId), isNull(rewards.archivedAt)),
      )
      .returning({ id: rewards.id });
    if (!row) return c.json({ error: 'not found', detail: 'reward not found in this tenant' }, 404);
    return c.body(null, 204);
  });
