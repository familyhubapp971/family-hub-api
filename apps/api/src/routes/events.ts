import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, gte, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { events, members } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { expandWeekOccurrences } from '../lib/recurrence.js';

// FHS-230 — GET + POST /api/events.
//
// Backs the Calendar tab on /t/:slug/dashboard. Calendar is week-based:
// GET takes ?weekStart=YYYY-MM-DD (a Monday) and returns every event
// in the 7-day window starting that day. POST creates one event with
// optional times and an optional member assignee.
//
// Read open to all members; create restricted to admin + adult.
//
// FHS-476 — weekly recurring activities. A series is ONE row (`date` is
// its anchor / first occurrence); GET expands it into virtual per-week
// occurrences via `expandWeekOccurrences` (apps/api/src/lib/recurrence.ts).
// Edit/delete act on the whole series (see PUT/DELETE below).

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEEKDAY = z.number().int().min(0).max(6);

export const eventTypeValues = ['school', 'home'] as const;

export const eventItemSchema = z.object({
  id: z.string().uuid(),
  date: z.string().regex(ISO_DATE),
  startTime: z.string().regex(HHMM).nullable(),
  endTime: z.string().regex(HHMM).nullable(),
  title: z.string(),
  notes: z.string().nullable(),
  memberId: z.string().uuid().nullable(),
  // FHS-265 — School/Home sub-tab + "where" + "what to wear".
  type: z.enum(eventTypeValues),
  location: z.string().nullable(),
  wear: z.string().nullable(),
  // FHS-476 — weekly recurrence. recurrenceDays/recurrenceEndDate always
  // describe the series (same on every occurrence); isRecurring is true
  // for a virtual occurrence generated from a repeating series, and for
  // the series row itself when it repeats. `seriesStartDate` is the
  // real, un-overwritten anchor date — always equal to `date` except on
  // a recurring occurrence that isn't the anchor day; a client editing
  // one of those must PUT `seriesStartDate` back as `date`, not the
  // occurrence's own `date`, or it will move the whole series.
  recurrenceDays: z.array(WEEKDAY).nullable(),
  recurrenceEndDate: z.string().regex(ISO_DATE).nullable(),
  isRecurring: z.boolean(),
  seriesStartDate: z.string().regex(ISO_DATE),
});

export const listEventsResponseSchema = z.object({
  weekStart: z.string().regex(ISO_DATE),
  events: z.array(eventItemSchema),
});

export type ListEventsResponse = z.infer<typeof listEventsResponseSchema>;

const queryParamsSchema = z.object({
  weekStart: z.string().regex(ISO_DATE, 'weekStart must be YYYY-MM-DD'),
});

export const createEventRequestSchema = z
  .object({
    date: z.string().regex(ISO_DATE, 'date must be YYYY-MM-DD'),
    title: z.string().trim().min(1, 'title is required').max(120),
    startTime: z.string().regex(HHMM).nullish(),
    endTime: z.string().regex(HHMM).nullish(),
    memberId: z.string().uuid().nullish(),
    notes: z.string().max(1000).nullish(),
    type: z.enum(eventTypeValues).default('home'),
    location: z.string().trim().max(120).nullish(),
    wear: z.string().trim().max(120).nullish(),
    // FHS-476 — "Repeat weekly": the weekdays it repeats on (0=Sun..6=Sat,
    // deduped + sorted) and an optional end date. Omit/null both for a
    // normal one-off event.
    recurrenceDays: z.array(WEEKDAY).min(1).max(7).nullish(),
    recurrenceEndDate: z.string().regex(ISO_DATE, 'recurrenceEndDate must be YYYY-MM-DD').nullish(),
  })
  .refine((d) => !d.endTime || !!d.startTime, {
    message: 'endTime requires startTime',
    path: ['endTime'],
  })
  .refine((d) => !(d.startTime && d.endTime) || d.endTime > d.startTime, {
    // HH:MM strings sort lexically by clock time so `>` is calendar-correct.
    message: 'endTime must be after startTime',
    path: ['endTime'],
  })
  .refine((d) => !d.recurrenceEndDate || d.recurrenceEndDate >= d.date, {
    // YYYY-MM-DD strings sort lexically by calendar date.
    message: 'recurrenceEndDate must be on or after date',
    path: ['recurrenceEndDate'],
  })
  .refine((d) => !d.recurrenceEndDate || (d.recurrenceDays && d.recurrenceDays.length > 0), {
    message: 'recurrenceEndDate requires recurrenceDays',
    path: ['recurrenceEndDate'],
  })
  .transform((d) => ({
    ...d,
    recurrenceDays: d.recurrenceDays
      ? [...new Set(d.recurrenceDays)].sort((a, b) => a - b)
      : (d.recurrenceDays ?? null),
  }));

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

// The series row itself (create/update response) isn't a computed
// occurrence, so `isRecurring`/`seriesStartDate` aren't DB columns —
// they're derived: `isRecurring` from whether the series repeats at
// all, `seriesStartDate` is just the row's own `date` (it IS the anchor).
function withIsRecurring<T extends { date: string; recurrenceDays: number[] | null }>(
  row: T,
): T & { isRecurring: boolean; seriesStartDate: string } {
  return {
    ...row,
    isRecurring: !!(row.recurrenceDays && row.recurrenceDays.length > 0),
    seriesStartDate: row.date,
  };
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

    // FHS-476 — fetch every row that could contribute an occurrence to
    // this week: a plain one-off event whose own date is in the window,
    // OR a recurring series whose anchor is on/before the week ends and
    // which hasn't already ended before the week starts. Expansion into
    // per-day occurrences happens in application code below.
    const rows = await db
      .select({
        id: events.id,
        date: events.date,
        startTime: events.startTime,
        endTime: events.endTime,
        title: events.title,
        notes: events.notes,
        memberId: events.memberId,
        type: events.type,
        location: events.location,
        wear: events.wear,
        recurrenceDays: events.recurrenceDays,
        recurrenceEndDate: events.recurrenceEndDate,
      })
      .from(events)
      .where(
        and(
          eq(events.tenantId, tenantId),
          or(
            and(gte(events.date, weekStart), lte(events.date, weekEnd)),
            and(
              isNotNull(events.recurrenceDays),
              lte(events.date, weekEnd),
              or(isNull(events.recurrenceEndDate), gte(events.recurrenceEndDate, weekStart)),
            ),
          ),
        ),
      )
      .orderBy(asc(events.date), asc(events.startTime));

    const occurrences = expandWeekOccurrences(rows, weekStart).sort((a, b) => {
      const dateCmp = a.date.localeCompare(b.date);
      if (dateCmp !== 0) return dateCmp;
      return (a.startTime ?? '99:99').localeCompare(b.startTime ?? '99:99');
    });

    const response: ListEventsResponse = {
      weekStart,
      events: occurrences.map((r) => ({
        id: r.id,
        date: r.date,
        startTime: r.startTime,
        endTime: r.endTime,
        title: r.title,
        notes: r.notes,
        memberId: r.memberId,
        type: r.type as (typeof eventTypeValues)[number],
        location: r.location,
        wear: r.wear,
        recurrenceDays: r.recurrenceDays,
        recurrenceEndDate: r.recurrenceEndDate,
        isRecurring: r.isRecurring,
        seriesStartDate: r.seriesStartDate,
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
        type: parsed.data.type,
        location: parsed.data.location ?? null,
        wear: parsed.data.wear ?? null,
        recurrenceDays: parsed.data.recurrenceDays,
        recurrenceEndDate: parsed.data.recurrenceEndDate ?? null,
      })
      .returning({
        id: events.id,
        date: events.date,
        startTime: events.startTime,
        endTime: events.endTime,
        title: events.title,
        notes: events.notes,
        memberId: events.memberId,
        type: events.type,
        location: events.location,
        wear: events.wear,
        recurrenceDays: events.recurrenceDays,
        recurrenceEndDate: events.recurrenceEndDate,
      });

    if (!row) {
      return c.json({ error: 'insert failed', errorCode: 'EVENT_INSERT_NO_ROW' }, 500);
    }

    return c.json(eventItemSchema.parse(withIsRecurring(row)), 201);
  })
  // Update an event (full replace). Admin + adult only; tenant-scoped.
  .put('/:id', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('events handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'invalid id', detail: 'event id must be a UUID' }, 400);
    }

    const db = getDb();
    const caller = await loadCallerMember(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    if (!WRITE_ROLES.has(caller.role)) {
      return c.json({ error: 'forbidden', detail: 'only admins and adults can edit events' }, 403);
    }

    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = createEventRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
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
      .update(events)
      .set({
        date: parsed.data.date,
        title: parsed.data.title,
        startTime: parsed.data.startTime ?? null,
        endTime: parsed.data.endTime ?? null,
        memberId: parsed.data.memberId ?? null,
        notes: parsed.data.notes ?? null,
        type: parsed.data.type,
        location: parsed.data.location ?? null,
        wear: parsed.data.wear ?? null,
        recurrenceDays: parsed.data.recurrenceDays,
        recurrenceEndDate: parsed.data.recurrenceEndDate ?? null,
      })
      .where(and(eq(events.id, id), eq(events.tenantId, tenantId)))
      .returning({
        id: events.id,
        date: events.date,
        startTime: events.startTime,
        endTime: events.endTime,
        title: events.title,
        notes: events.notes,
        memberId: events.memberId,
        type: events.type,
        location: events.location,
        wear: events.wear,
        recurrenceDays: events.recurrenceDays,
        recurrenceEndDate: events.recurrenceEndDate,
      });

    if (!row) {
      return c.json({ error: 'not found', detail: 'event not found in this tenant' }, 404);
    }
    return c.json(eventItemSchema.parse(withIsRecurring(row)));
  })
  // Delete an event. Admin + adult only; tenant-scoped.
  .delete('/:id', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('events handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'invalid id', detail: 'event id must be a UUID' }, 400);
    }

    const db = getDb();
    const caller = await loadCallerMember(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    if (!WRITE_ROLES.has(caller.role)) {
      return c.json(
        { error: 'forbidden', detail: 'only admins and adults can delete events' },
        403,
      );
    }

    const deleted = await db
      .delete(events)
      .where(and(eq(events.id, id), eq(events.tenantId, tenantId)))
      .returning({ id: events.id });
    if (deleted.length === 0) {
      return c.json({ error: 'not found', detail: 'event not found in this tenant' }, 404);
    }
    return c.body(null, 204);
  });
