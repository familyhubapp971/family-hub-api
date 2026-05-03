import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { events, members } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';

// FHS-230 — GET + POST /api/events.
//
// Backs the Calendar tab on /t/:slug/dashboard. Calendar is week-based:
// GET takes ?weekStart=YYYY-MM-DD (a Monday) and returns every event
// in the 7-day window starting that day. POST creates one event with
// optional times and an optional member assignee.
//
// Read open to all members; create restricted to admin + adult.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const eventItemSchema = z.object({
  id: z.string().uuid(),
  date: z.string().regex(ISO_DATE),
  startTime: z.string().regex(HHMM).nullable(),
  endTime: z.string().regex(HHMM).nullable(),
  title: z.string(),
  notes: z.string().nullable(),
  memberId: z.string().uuid().nullable(),
});

export const listEventsResponseSchema = z.object({
  weekStart: z.string().regex(ISO_DATE),
  events: z.array(eventItemSchema),
});

export type ListEventsResponse = z.infer<typeof listEventsResponseSchema>;

const queryParamsSchema = z.object({
  weekStart: z.string().regex(ISO_DATE, 'weekStart must be YYYY-MM-DD'),
});

const createEventRequestSchema = z
  .object({
    date: z.string().regex(ISO_DATE, 'date must be YYYY-MM-DD'),
    title: z.string().trim().min(1, 'title is required').max(120),
    startTime: z.string().regex(HHMM).nullish(),
    endTime: z.string().regex(HHMM).nullish(),
    memberId: z.string().uuid().nullish(),
    notes: z.string().max(1000).nullish(),
  })
  .refine((d) => !d.endTime || !!d.startTime, {
    message: 'endTime requires startTime',
    path: ['endTime'],
  })
  .refine((d) => !(d.startTime && d.endTime) || d.endTime > d.startTime, {
    // HH:MM strings sort lexically by clock time so `>` is calendar-correct.
    message: 'endTime must be after startTime',
    path: ['endTime'],
  });

const WRITE_ROLES = new Set(['admin', 'adult']);

async function loadCallerMember(
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

// Add `days` calendar days to an ISO YYYY-MM-DD string. Anchors at UTC
// so the math is always exactly `days * 24h` — no DST drift.
function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((s) => Number.parseInt(s, 10));
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export const eventsRouter = new Hono()
  .get('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('events handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }

    const parsed = queryParamsSchema.safeParse({ weekStart: c.req.query('weekStart') });
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid query',
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        400,
      );
    }

    const db = getDb();
    const caller = await loadCallerMember(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }

    const weekStart = parsed.data.weekStart;
    const weekEnd = addDays(weekStart, 6);

    const rows = await db
      .select({
        id: events.id,
        date: events.date,
        startTime: events.startTime,
        endTime: events.endTime,
        title: events.title,
        notes: events.notes,
        memberId: events.memberId,
      })
      .from(events)
      .where(
        and(eq(events.tenantId, tenantId), gte(events.date, weekStart), lte(events.date, weekEnd)),
      )
      .orderBy(asc(events.date), asc(events.startTime));

    const response: ListEventsResponse = {
      weekStart,
      events: rows.map((r) => ({
        id: r.id,
        date: r.date,
        startTime: r.startTime,
        endTime: r.endTime,
        title: r.title,
        notes: r.notes,
        memberId: r.memberId,
      })),
    };
    return c.json(listEventsResponseSchema.parse(response));
  })
  .post('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('events handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }

    const db = getDb();
    const caller = await loadCallerMember(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    if (!WRITE_ROLES.has(caller.role)) {
      return c.json({ error: 'forbidden', detail: 'only admins and adults can add events' }, 403);
    }

    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = createEventRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        400,
      );
    }

    // If memberId is provided, confirm the member belongs to the same
    // tenant — prevents an admin from assigning an event to a member
    // in a different family by id-guessing.
    if (parsed.data.memberId) {
      const memberRows = await db
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.tenantId, tenantId), eq(members.id, parsed.data.memberId)))
        .limit(1);
      if (memberRows.length === 0) {
        return c.json(
          { error: 'invalid memberId', detail: 'memberId is not a member of this tenant' },
          400,
        );
      }
    }

    const [row] = await db
      .insert(events)
      .values({
        tenantId,
        date: parsed.data.date,
        title: parsed.data.title,
        startTime: parsed.data.startTime ?? null,
        endTime: parsed.data.endTime ?? null,
        memberId: parsed.data.memberId ?? null,
        notes: parsed.data.notes ?? null,
      })
      .returning({
        id: events.id,
        date: events.date,
        startTime: events.startTime,
        endTime: events.endTime,
        title: events.title,
        notes: events.notes,
        memberId: events.memberId,
      });

    if (!row) {
      return c.json({ error: 'insert failed', errorCode: 'EVENT_INSERT_NO_ROW' }, 500);
    }

    return c.json(eventItemSchema.parse(row), 201);
  });
