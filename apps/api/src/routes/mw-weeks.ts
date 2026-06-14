import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { habitStickers, members, mwWeeks } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { getOrCreateCurrentWeek, STICKER_TO_AED } from '../lib/myworld.js';

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

async function loadCaller(
  db: Db,
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

async function memberInTenant(db: Db, tenantId: string, memberId: string): Promise<boolean> {
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.id, memberId)))
    .limit(1);
  return rows.length > 0;
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

/**
 * Run the standard auth + tenant + member guard for a GET route that accepts
 * `?memberId=<uuid>` as a query parameter. Returns the resolved context or an
 * early Response to return immediately.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function guardQuery(
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
  // GET / — all weeks for a member, ordered by (year, weekNumber) ascending.
  // Ensures the current week exists first so the list is never empty.
  .get('/', async (c) => {
    const ctx = await guardQuery(c);
    if ('res' in ctx) return ctx.res;
    const { db, tenantId, memberId } = ctx;

    // Ensure the current week exists before listing.
    await getOrCreateCurrentWeek(db, tenantId, memberId);

    const rows = await db
      .select()
      .from(mwWeeks)
      .where(and(eq(mwWeeks.tenantId, tenantId), eq(mwWeeks.memberId, memberId)))
      .orderBy(asc(mwWeeks.year), asc(mwWeeks.weekNumber));

    return c.json({ weeks: rows.map(toWeek) });
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

    // Validate the week belongs to this (tenant, member).
    const weekRows = await db
      .select()
      .from(mwWeeks)
      .where(
        and(eq(mwWeeks.id, weekId), eq(mwWeeks.tenantId, tenantId), eq(mwWeeks.memberId, memberId)),
      )
      .limit(1);

    if (!weekRows[0]) {
      return c.json({ error: 'not found', detail: 'week not found for this member' }, 404);
    }

    // Total stickers earned this week.
    const [totalRow] = await db
      .select({
        count: sql<string>`coalesce(sum(${habitStickers.stickerValue}), 0)`,
      })
      .from(habitStickers)
      .where(
        and(
          eq(habitStickers.tenantId, tenantId),
          eq(habitStickers.memberId, memberId),
          eq(habitStickers.weekId, weekId),
        ),
      );

    // Unallocated (spendable) stickers.
    const [unallocatedRow] = await db
      .select({
        count: sql<string>`coalesce(sum(${habitStickers.stickerValue}), 0)`,
      })
      .from(habitStickers)
      .where(
        and(
          eq(habitStickers.tenantId, tenantId),
          eq(habitStickers.memberId, memberId),
          eq(habitStickers.weekId, weekId),
          eq(habitStickers.isAllocated, false),
        ),
      );

    // Allocated (already spent / saved) stickers.
    const [allocatedRow] = await db
      .select({
        count: sql<string>`coalesce(sum(${habitStickers.stickerValue}), 0)`,
      })
      .from(habitStickers)
      .where(
        and(
          eq(habitStickers.tenantId, tenantId),
          eq(habitStickers.memberId, memberId),
          eq(habitStickers.weekId, weekId),
          eq(habitStickers.isAllocated, true),
        ),
      );

    const totalStickers = Number(totalRow?.count ?? 0);
    const unallocatedStickers = Number(unallocatedRow?.count ?? 0);
    const allocatedStickers = Number(allocatedRow?.count ?? 0);

    return c.json({
      weekId,
      totalStickers,
      unallocatedStickers,
      allocatedStickers,
      cashValue: unallocatedStickers * STICKER_TO_AED,
    });
  });
