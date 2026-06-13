import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { habits, habitLogs, members } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';

// FHS-268 — GET /api/habits, PATCH /api/habits/:id/log.
//
// Powers the kid My World habit tracker. GET returns the family's
// (non-archived) habits plus the chosen member's logged days for a week;
// PATCH toggles a single (habit, member, day) on or off. Each logged day
// is worth one sticker — the balance maths lives in the rewards route.
// Accessed by a parent viewing a child's world (standard parent auth);
// memberId is passed explicitly and validated against the tenant.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const habitItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  cadence: z.string(),
  targetCount: z.number().int(),
  color: z.string(),
});

export const habitLogItemSchema = z.object({
  habitId: z.string().uuid(),
  logDate: z.string().regex(ISO_DATE),
});

export const listHabitsResponseSchema = z.object({
  habits: z.array(habitItemSchema),
  logs: z.array(habitLogItemSchema),
});

const listQuerySchema = z.object({
  memberId: z.string().uuid(),
  weekStart: z.string().regex(ISO_DATE, 'weekStart must be YYYY-MM-DD'),
});

const logRequestSchema = z.object({
  memberId: z.string().uuid(),
  date: z.string().regex(ISO_DATE, 'date must be YYYY-MM-DD'),
  done: z.boolean(),
});

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((s) => Number.parseInt(s, 10));
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  return dt.toISOString().slice(0, 10);
}

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

export const habitsRouter = new Hono()
  .get('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('habits handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const parsed = listQuerySchema.safeParse({
      memberId: c.req.query('memberId'),
      weekStart: c.req.query('weekStart'),
    });
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
    const weekEnd = addDays(parsed.data.weekStart, 6);
    const [habitRows, logRows] = await Promise.all([
      db
        .select({
          id: habits.id,
          name: habits.name,
          description: habits.description,
          cadence: habits.cadence,
          targetCount: habits.targetCount,
          color: habits.color,
        })
        .from(habits)
        .where(and(eq(habits.tenantId, tenantId), isNull(habits.archivedAt)))
        .orderBy(asc(habits.createdAt)),
      db
        .select({ habitId: habitLogs.habitId, logDate: habitLogs.logDate })
        .from(habitLogs)
        .where(
          and(
            eq(habitLogs.tenantId, tenantId),
            eq(habitLogs.memberId, parsed.data.memberId),
            gte(habitLogs.logDate, parsed.data.weekStart),
            lte(habitLogs.logDate, weekEnd),
          ),
        ),
    ]);
    return c.json(
      listHabitsResponseSchema.parse({
        habits: habitRows,
        logs: logRows.map((r) => ({ habitId: r.habitId, logDate: r.logDate })),
      }),
    );
  })
  .patch('/:id/log', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('habits handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const habitId = c.req.param('id');
    if (!UUID_RE.test(habitId)) {
      return c.json({ error: 'invalid id', detail: 'habit id must be a UUID' }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = logRequestSchema.safeParse(body);
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
    // Validate the habit belongs to this tenant before logging against it.
    const habitRows = await db
      .select({ id: habits.id })
      .from(habits)
      .where(and(eq(habits.tenantId, tenantId), eq(habits.id, habitId)))
      .limit(1);
    if (habitRows.length === 0) {
      return c.json({ error: 'not found', detail: 'habit not found in this tenant' }, 404);
    }
    if (parsed.data.done) {
      await db
        .insert(habitLogs)
        .values({
          tenantId,
          habitId,
          memberId: parsed.data.memberId,
          logDate: parsed.data.date,
        })
        .onConflictDoNothing();
    } else {
      await db
        .delete(habitLogs)
        .where(
          and(
            eq(habitLogs.tenantId, tenantId),
            eq(habitLogs.habitId, habitId),
            eq(habitLogs.memberId, parsed.data.memberId),
            eq(habitLogs.logDate, parsed.data.date),
          ),
        );
    }
    return c.json({ logged: parsed.data.done });
  });
