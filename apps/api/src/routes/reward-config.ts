import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { members, tenants } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { loadCaller, isAdmin } from '../lib/permissions.js';
import { effectiveRateMinor } from '../lib/reward-config.js';

// FHS-512: the "Pocket money" reward-config screen's backing API.
//
// GET  /api/reward-config: any family member can read the current setup
//                            (family default rate + each kid's override).
// PUT  /api/reward-config: admin-only. Updates the family default rate
//                            and/or one or more kids' overrides in one call.
//
// MONEY RULE: every rate here is an INTEGER in minor currency units: the
// request/response schemas reject a float or a fractional value.
//
// FIX 2 (BLOCKER): a rate of 0 makes "1 sticker = free money": every
// cash→stickers conversion divides by the rate, so 0 resolves to
// Infinity/NaN stickers and `balance < cost` never blocks a redemption.
// Rates are `.min(1)` (never 0), not `.min(0)`.
// FIX 3 (BLOCKER): no upper bound let an oversized rate reach Postgres'
// numeric(12,2) column and 500. `.max(100000)` caps it at 1000.00/sticker,
// matching the existing `boost.max(20)` pattern.
const RATE_MINOR_MAX = 100_000; // 1000.00 in the tenant's currency

const memberRateSchema = z.object({
  memberId: z.string().uuid(),
  displayName: z.string(),
  avatarEmoji: z.string().nullable(),
  // null = this child uses the family default.
  rateMinor: z.number().int().min(1).max(RATE_MINOR_MAX).nullable(),
  effectiveRateMinor: z.number().int().min(1).max(RATE_MINOR_MAX),
});

export const rewardConfigResponseSchema = z.object({
  currency: z.string(),
  familyRateMinor: z.number().int().min(1).max(RATE_MINOR_MAX),
  members: z.array(memberRateSchema),
});

export const rewardConfigPutRequestSchema = z.object({
  familyRateMinor: z.number().int().min(1).max(RATE_MINOR_MAX).optional(),
  memberOverrides: z
    .array(
      z.object({
        memberId: z.string().uuid(),
        // null clears the override (back to the family default).
        rateMinor: z.number().int().min(1).max(RATE_MINOR_MAX).nullable(),
      }),
    )
    .optional(),
});

type Db = ReturnType<typeof getDb>;

async function guardTenant(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
): Promise<{ db: Db; tenantId: string; caller: { id: string; role: string } } | { res: Response }> {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) throw new Error('reward-config handler reached without userRow');
  const tenantId = c.get('tenantId') as string | undefined;
  if (!tenantId) {
    return { res: c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400) };
  }
  const db = getDb();
  const caller = await loadCaller(db, tenantId, userRow.id);
  if (!caller) {
    return { res: c.json({ error: 'forbidden', detail: 'caller is not a member' }, 403) };
  }
  return { db, tenantId, caller };
}

async function loadConfig(db: Db, tenantId: string) {
  const [tenantRow, kidRows] = await Promise.all([
    db
      .select({ currency: tenants.currency, stickerRateMinor: tenants.stickerRateMinor })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1),
    db
      .select({
        id: members.id,
        displayName: members.displayName,
        avatarEmoji: members.avatarEmoji,
        stickerRateMinor: members.stickerRateMinor,
      })
      .from(members)
      .where(and(eq(members.tenantId, tenantId), eq(members.isChild, true)))
      .orderBy(asc(members.createdAt)),
  ]);
  const tenant = tenantRow[0];
  const familyRateMinor = tenant?.stickerRateMinor ?? 50;
  const currency = tenant?.currency ?? 'USD';
  return {
    currency,
    familyRateMinor,
    members: kidRows.map((m) => ({
      memberId: m.id,
      displayName: m.displayName,
      avatarEmoji: m.avatarEmoji,
      rateMinor: m.stickerRateMinor,
      effectiveRateMinor: effectiveRateMinor(
        { stickerRateMinor: m.stickerRateMinor },
        { stickerRateMinor: familyRateMinor },
      ),
    })),
  };
}

export const rewardConfigRouter = new Hono()
  // GET: any authenticated family member.
  .get('/', async (c) => {
    const ctx = await guardTenant(c);
    if ('res' in ctx) return ctx.res;
    const { db, tenantId } = ctx;
    return c.json(rewardConfigResponseSchema.parse(await loadConfig(db, tenantId)));
  })
  // PUT: admin-only.
  .put('/', async (c) => {
    const ctx = await guardTenant(c);
    if ('res' in ctx) return ctx.res;
    const { db, tenantId, caller } = ctx;

    if (!isAdmin(caller)) {
      return c.json(
        { error: 'forbidden', errorCode: 'ADMIN_ONLY', detail: 'admin role required' },
        403,
      );
    }

    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = rewardConfigPutRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const { familyRateMinor, memberOverrides } = parsed.data;

    if (familyRateMinor !== undefined) {
      await db
        .update(tenants)
        .set({ stickerRateMinor: familyRateMinor, updatedAt: new Date() })
        .where(eq(tenants.id, tenantId));
    }

    if (memberOverrides && memberOverrides.length > 0) {
      const memberIds = memberOverrides.map((o) => o.memberId);
      // Scope to this tenant so a caller can never set another family's
      // member rate: the WHERE below filters by tenantId on every write.
      const existing = await db
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.tenantId, tenantId), inArray(members.id, memberIds)));
      const validIds = new Set(existing.map((m) => m.id));
      for (const override of memberOverrides) {
        if (!validIds.has(override.memberId)) continue; // silently skip a foreign/unknown id
        await db
          .update(members)
          .set({ stickerRateMinor: override.rateMinor, updatedAt: new Date() })
          .where(and(eq(members.tenantId, tenantId), eq(members.id, override.memberId)));
      }
    }

    return c.json(rewardConfigResponseSchema.parse(await loadConfig(db, tenantId)));
  });
