import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { habits, habitStickers, members, mwWeeks } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { getOrCreateCurrentWeek, getTenantCurrency, stickerBalance } from '../lib/myworld.js';

// FHS-292 — habits CRUD + weekly typed-sticker grid (My World).
//
// Ported from legacy family-hub: each habit day holds a sticker TYPE
// (gold-star / heart / magic / trophy) worth `stickerValue` (5 for bonus
// habits, else 1), scoped to a Monday-anchored week. Parent-accessed
// (standard auth); memberId is passed + validated. A caller may manage a
// member's habits only if they ARE that member or a parent (admin/adult).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STICKER_TYPES = ['gold-star', 'heart', 'magic', 'trophy'] as const;

export const habitItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string(),
  icon: z.string().nullable(),
  isBonus: z.boolean(),
});

export const stickerItemSchema = z.object({
  habitId: z.string().uuid(),
  day: z.number().int().min(0).max(6),
  sticker: z.enum(STICKER_TYPES),
  stickerValue: z.number().int(),
});

export const weekItemSchema = z.object({
  id: z.string().uuid(),
  weekNumber: z.number().int(),
  year: z.number().int(),
  startDate: z.string(),
  isFinalized: z.boolean(),
});

export const listHabitsResponseSchema = z.object({
  habits: z.array(habitItemSchema),
  stickers: z.array(stickerItemSchema),
  week: weekItemSchema,
  balance: z.number().int(),
  // The family's currency (chosen at registration) — drives the cash
  // labels in My World (stickers convert at a fixed 0.5 per sticker).
  currency: z.string(),
});

const memberQuerySchema = z.object({ memberId: z.string().uuid() });
const createSchema = z.object({
  memberId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  icon: z.string().trim().max(40).nullish(),
  color: z.string().trim().max(40).optional(),
  isBonus: z.boolean().optional(),
});
const updateSchema = z.object({
  memberId: z.string().uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  icon: z.string().trim().max(40).nullish(),
  color: z.string().trim().max(40).optional(),
  isBonus: z.boolean().optional(),
});
const deleteSchema = z.object({
  memberId: z.string().uuid(),
});
const placeStickerSchema = z.object({
  memberId: z.string().uuid(),
  weekId: z.string().uuid(),
  day: z.number().int().min(0).max(6),
  sticker: z.enum(STICKER_TYPES),
});
const removeStickerSchema = z.object({
  memberId: z.string().uuid(),
  weekId: z.string().uuid(),
  day: z.number().int().min(0).max(6),
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

export const habitsRouter = new Hono()
  // List habits + this member's stickers for a week (defaults to the
  // current open week) + their spendable balance.
  .get('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('habits handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const parsed = memberQuerySchema.safeParse({ memberId: c.req.query('memberId') });
    if (!parsed.success) return badRequest(c, parsed.error);
    const db = getDb();
    const caller = await loadCaller(db, tenantId, userRow.id);
    if (!caller) return c.json({ error: 'forbidden', detail: 'caller is not a member' }, 403);
    if (!(await memberInTenant(db, tenantId, parsed.data.memberId))) {
      return c.json({ error: 'not found', detail: 'member not found in this tenant' }, 404);
    }
    if (!canManage(caller, parsed.data.memberId)) {
      return c.json({ error: 'forbidden', detail: 'not allowed for this member' }, 403);
    }
    const { memberId } = parsed.data;
    // A specific week may be requested (FHS-293 navigation); else current.
    const weekIdParam = c.req.query('weekId');
    let week;
    if (weekIdParam && UUID_RE.test(weekIdParam)) {
      const rows = await db
        .select()
        .from(mwWeeks)
        .where(
          and(
            eq(mwWeeks.tenantId, tenantId),
            eq(mwWeeks.memberId, memberId),
            eq(mwWeeks.id, weekIdParam),
          ),
        )
        .limit(1);
      week = rows[0] ?? (await getOrCreateCurrentWeek(db, tenantId, memberId));
    } else {
      week = await getOrCreateCurrentWeek(db, tenantId, memberId);
    }
    const [habitRows, stickerRows, balance, currency] = await Promise.all([
      db
        .select({
          id: habits.id,
          name: habits.name,
          description: habits.description,
          color: habits.color,
          icon: habits.icon,
          isBonus: habits.isBonus,
        })
        .from(habits)
        .where(
          and(
            eq(habits.tenantId, tenantId),
            eq(habits.memberId, memberId),
            isNull(habits.archivedAt),
          ),
        )
        .orderBy(asc(habits.createdAt)),
      db
        .select({
          habitId: habitStickers.habitId,
          day: habitStickers.day,
          sticker: habitStickers.sticker,
          stickerValue: habitStickers.stickerValue,
        })
        .from(habitStickers)
        .where(
          and(
            eq(habitStickers.tenantId, tenantId),
            eq(habitStickers.memberId, memberId),
            eq(habitStickers.weekId, week.id),
          ),
        ),
      stickerBalance(db, tenantId, memberId),
      getTenantCurrency(db, tenantId),
    ]);
    return c.json(
      listHabitsResponseSchema.parse({
        habits: habitRows,
        stickers: stickerRows,
        week: {
          id: week.id,
          weekNumber: week.weekNumber,
          year: week.year,
          startDate: week.startDate,
          isFinalized: week.isFinalized,
        },
        balance,
        currency,
      }),
    );
  })
  // Create a habit.
  .post('/', async (c) => {
    const ctx = await guard(c);
    if ('res' in ctx) return ctx.res;
    const { db, tenantId, parsed } = await parseBody(c, ctx, createSchema);
    if ('res' in parsed) return parsed.res;
    const { memberId, name, icon, color, isBonus } = parsed.data;
    const [row] = await db
      .insert(habits)
      .values({
        tenantId,
        memberId,
        name,
        icon: icon ?? null,
        color: color ?? '#facc15',
        isBonus: isBonus ?? false,
      })
      .returning();
    return c.json(toHabit(row!), 201);
  })
  // Update a habit.
  .put('/:id', async (c) => {
    const ctx = await guard(c);
    if ('res' in ctx) return ctx.res;
    const habitId = c.req.param('id');
    if (!UUID_RE.test(habitId)) {
      return c.json({ error: 'invalid id', detail: 'habit id must be a UUID' }, 400);
    }
    const { db, tenantId, parsed } = await parseBody(c, ctx, updateSchema);
    if ('res' in parsed) return parsed.res;
    const { memberId } = parsed.data;
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.icon !== undefined) patch.icon = parsed.data.icon;
    if (parsed.data.color !== undefined) patch.color = parsed.data.color;
    if (parsed.data.isBonus !== undefined) patch.isBonus = parsed.data.isBonus;
    // FIX 2: scope to memberId so a caller cannot edit another child's habit.
    const [row] = await db
      .update(habits)
      .set(patch)
      .where(
        and(eq(habits.tenantId, tenantId), eq(habits.memberId, memberId), eq(habits.id, habitId)),
      )
      .returning();
    if (!row) return c.json({ error: 'not found', detail: 'habit not found for this member' }, 404);
    return c.json(toHabit(row));
  })
  // Delete a habit (its stickers cascade).
  .delete('/:id', async (c) => {
    const ctx = await guard(c);
    if ('res' in ctx) return ctx.res;
    const habitId = c.req.param('id');
    if (!UUID_RE.test(habitId)) {
      return c.json({ error: 'invalid id', detail: 'habit id must be a UUID' }, 400);
    }
    // FIX 2: parse memberId from body so the DELETE is scoped to that member.
    const { db, tenantId, parsed } = await parseBody(c, ctx, deleteSchema);
    if ('res' in parsed) return parsed.res;
    const { memberId } = parsed.data;
    const deleted = await db
      .delete(habits)
      .where(
        and(eq(habits.tenantId, tenantId), eq(habits.memberId, memberId), eq(habits.id, habitId)),
      )
      .returning({ id: habits.id });
    if (deleted.length === 0) {
      return c.json({ error: 'not found', detail: 'habit not found for this member' }, 404);
    }
    return c.body(null, 204);
  })
  // Place a typed sticker on a (habit, day) in a week.
  .post('/:id/stickers', async (c) => {
    const ctx = await guard(c);
    if ('res' in ctx) return ctx.res;
    const habitId = c.req.param('id');
    if (!UUID_RE.test(habitId)) {
      return c.json({ error: 'invalid id', detail: 'habit id must be a UUID' }, 400);
    }
    const { db, tenantId, parsed } = await parseBody(c, ctx, placeStickerSchema);
    if ('res' in parsed) return parsed.res;
    const { memberId, weekId, day, sticker } = parsed.data;
    // Scope the habit lookup to this member so a caller cannot place a sticker
    // on another child's habit and credit it to this member's balance.
    const habitRows = await db
      .select({ id: habits.id, isBonus: habits.isBonus })
      .from(habits)
      .where(
        and(eq(habits.tenantId, tenantId), eq(habits.memberId, memberId), eq(habits.id, habitId)),
      )
      .limit(1);
    const habit = habitRows[0];
    if (!habit)
      return c.json({ error: 'not found', detail: 'habit not found for this member' }, 404);
    const stickerValue = habit.isBonus ? 5 : 1;
    await db
      .insert(habitStickers)
      .values({ tenantId, memberId, habitId, weekId, day, sticker, stickerValue })
      .onConflictDoUpdate({
        target: [
          habitStickers.tenantId,
          habitStickers.memberId,
          habitStickers.habitId,
          habitStickers.weekId,
          habitStickers.day,
        ],
        set: { sticker, stickerValue, updatedAt: new Date() },
      });
    return c.json({ habitId, day, sticker, stickerValue });
  })
  // Remove a sticker from a (habit, day) in a week.
  .delete('/:id/stickers', async (c) => {
    const ctx = await guard(c);
    if ('res' in ctx) return ctx.res;
    const habitId = c.req.param('id');
    if (!UUID_RE.test(habitId)) {
      return c.json({ error: 'invalid id', detail: 'habit id must be a UUID' }, 400);
    }
    const { db, tenantId, parsed } = await parseBody(c, ctx, removeStickerSchema);
    if ('res' in parsed) return parsed.res;
    const { memberId, weekId, day } = parsed.data;
    await db
      .delete(habitStickers)
      .where(
        and(
          eq(habitStickers.tenantId, tenantId),
          eq(habitStickers.memberId, memberId),
          eq(habitStickers.habitId, habitId),
          eq(habitStickers.weekId, weekId),
          eq(habitStickers.day, day),
        ),
      );
    return c.body(null, 204);
  });

// ─── shared guard/body helpers (auth + tenant + member + role) ───────────────

type Guarded = {
  db: ReturnType<typeof getDb>;
  tenantId: string;
  userMemberId: string;
  role: string;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function guard(c: any): Promise<Guarded | { res: Response }> {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) throw new Error('habits handler reached without userRow');
  const tenantId = c.get('tenantId');
  if (!tenantId) {
    return { res: c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400) };
  }
  const db = getDb();
  const caller = await loadCaller(db, tenantId, userRow.id);
  if (!caller)
    return { res: c.json({ error: 'forbidden', detail: 'caller is not a member' }, 403) };
  return { db, tenantId, userMemberId: caller.id, role: caller.role };
}
async function parseBody<T extends z.ZodTypeAny>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  ctx: Guarded,
  schema: T,
): Promise<{
  db: ReturnType<typeof getDb>;
  tenantId: string;
  parsed: { data: z.infer<T> } | { res: Response };
}> {
  const body = (await c.req.json().catch(() => null)) as unknown;
  const result = schema.safeParse(body);
  if (!result.success)
    return { db: ctx.db, tenantId: ctx.tenantId, parsed: { res: badRequest(c, result.error) } };
  const memberId = (result.data as { memberId: string }).memberId;
  if (!(await memberInTenant(ctx.db, ctx.tenantId, memberId))) {
    return {
      db: ctx.db,
      tenantId: ctx.tenantId,
      parsed: {
        res: c.json({ error: 'not found', detail: 'member not found in this tenant' }, 404),
      },
    };
  }
  if (!canManage({ id: ctx.userMemberId, role: ctx.role }, memberId)) {
    return {
      db: ctx.db,
      tenantId: ctx.tenantId,
      parsed: { res: c.json({ error: 'forbidden', detail: 'not allowed for this member' }, 403) },
    };
  }
  return { db: ctx.db, tenantId: ctx.tenantId, parsed: { data: result.data } };
}

function toHabit(row: typeof habits.$inferSelect) {
  return habitItemSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    icon: row.icon,
    isBonus: row.isBonus,
  });
}
