import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, count, eq, isNull, sql, sum } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { rewards, rewardRedemptions, habitLogs, members } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';

// FHS-268 — GET /api/rewards, POST /api/rewards/:id/redeem.
//
// The kid Rewards Shop. GET returns the family's (non-archived) rewards
// plus the chosen member's sticker balance; POST spends stickers on a
// reward and records the redemption. Balance =
//   count(habit_logs for member) − sum(reward_redemptions.sticker_cost).
// Accessed by a parent viewing a child's world (standard parent auth);
// memberId is passed explicitly and validated against the tenant.

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

// Sticker balance: one sticker per logged habit day, minus what's been
// spent on rewards. Postgres SUM(numeric) comes back as a string, so
// coerce; COUNT comes back typed as a number from drizzle.
async function stickerBalance(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  memberId: string,
): Promise<number> {
  const [earnedRow, spentRow] = await Promise.all([
    db
      .select({ c: count() })
      .from(habitLogs)
      .where(and(eq(habitLogs.tenantId, tenantId), eq(habitLogs.memberId, memberId))),
    db
      .select({ s: sum(rewardRedemptions.stickerCost) })
      .from(rewardRedemptions)
      .where(
        and(eq(rewardRedemptions.tenantId, tenantId), eq(rewardRedemptions.memberId, memberId)),
      ),
  ]);
  const earned = earnedRow[0]?.c ?? 0;
  const spent = Number(spentRow[0]?.s ?? 0);
  return earned - spent;
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
      .select({ id: rewards.id, stickerCost: rewards.stickerCost })
      .from(rewards)
      .where(
        and(eq(rewards.tenantId, tenantId), eq(rewards.id, rewardId), isNull(rewards.archivedAt)),
      )
      .limit(1);
    const reward = rewardRows[0];
    if (!reward) {
      return c.json({ error: 'not found', detail: 'reward not found in this tenant' }, 404);
    }
    // Serialize redemptions per (tenant, member) inside a transaction with
    // a Postgres advisory lock so two concurrent redeems can't both pass
    // the balance check and double-spend (TOCTOU). The lock is held for
    // the transaction; a second redeem waits, then re-reads the now-lower
    // balance and 409s.
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${parsed.data.memberId}`}, 0))`,
      );
      const [earnedRow, spentRow] = await Promise.all([
        tx
          .select({ c: count() })
          .from(habitLogs)
          .where(
            and(eq(habitLogs.tenantId, tenantId), eq(habitLogs.memberId, parsed.data.memberId)),
          ),
        tx
          .select({ s: sum(rewardRedemptions.stickerCost) })
          .from(rewardRedemptions)
          .where(
            and(
              eq(rewardRedemptions.tenantId, tenantId),
              eq(rewardRedemptions.memberId, parsed.data.memberId),
            ),
          ),
      ]);
      const balance = (earnedRow[0]?.c ?? 0) - Number(spentRow[0]?.s ?? 0);
      if (balance < reward.stickerCost) {
        return { ok: false as const, balance };
      }
      const [redemption] = await tx
        .insert(rewardRedemptions)
        .values({
          tenantId,
          rewardId,
          memberId: parsed.data.memberId,
          stickerCost: reward.stickerCost,
        })
        .returning({ id: rewardRedemptions.id });
      return { ok: true as const, balance: balance - reward.stickerCost, id: redemption!.id };
    });
    if (!outcome.ok) {
      return c.json(
        {
          error: 'insufficient stickers',
          errorCode: 'INSUFFICIENT_STICKERS',
          detail: `needs ${reward.stickerCost}, has ${outcome.balance}`,
        },
        409,
      );
    }
    return c.json({ stickerBalance: outcome.balance, redemptionId: outcome.id }, 201);
  });
