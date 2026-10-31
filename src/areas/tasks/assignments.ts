import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../../database/client.js';
import { assignments, members } from '../../database/schema.js';
import { getAuthenticatedUser } from '../../security/auth.js';

// FHS-231: GET / POST / PATCH /api/assignments.
//
// Backs the Assignments tab. Per-family homework / chore list.
// GET: returns every assignment, ordered by due date (NULLs last) then
// created_at: open / overdue assignments sit on top, undated tasks
// trail behind.
// POST: create one assignment (admin/adult only).
// PATCH /:id: toggle done (admin/adult only). Body: { done: boolean }.
// `done` true sets done_at = now(); false clears it.
// DELETE /:id: remove one for good (admin/adult only, FHR-41).

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const assignmentItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  notes: z.string().nullable(),
  dueDate: z.string().regex(ISO_DATE).nullable(),
  memberId: z.string().uuid().nullable(),
  done: z.boolean(),
  doneAt: z.string().datetime().nullable(),
});

export const listAssignmentsResponseSchema = z.object({
  assignments: z.array(assignmentItemSchema),
});

export type ListAssignmentsResponse = z.infer<typeof listAssignmentsResponseSchema>;

// FHR-39: short enough that a card stays readable on a phone.
export const ASSIGNMENT_TITLE_MAX = 50;
export const ASSIGNMENT_NOTES_MAX = 300;

export const createAssignmentRequestSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'title is required')
    .max(ASSIGNMENT_TITLE_MAX, `Title must be ${ASSIGNMENT_TITLE_MAX} characters or fewer`),
  dueDate: z.string().regex(ISO_DATE, 'dueDate must be YYYY-MM-DD').nullish(),
  memberId: z.string().uuid().nullish(),
  notes: z
    .string()
    .max(ASSIGNMENT_NOTES_MAX, `Notes must be ${ASSIGNMENT_NOTES_MAX} characters or fewer`)
    .nullish(),
});

// FHR-40: a due date can't be in the past. The form uses the device's own
// date; the server can't know the family's time zone, so it allows one day
// of slack (the earliest local date anywhere is UTC today minus one).
export function earliestAllowedDueDate(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return d.toISOString().slice(0, 10);
}

const PAST_DUE_DATE = {
  error: 'invalid request',
  issues: [{ path: 'dueDate', message: 'Pick today or a later date' }],
};

export const patchAssignmentRequestSchema = z.object({
  done: z.boolean(),
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

function rowToItem(r: {
  id: string;
  title: string;
  notes: string | null;
  dueDate: string | null;
  memberId: string | null;
  doneAt: Date | null;
}) {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    dueDate: r.dueDate,
    memberId: r.memberId,
    done: r.doneAt !== null,
    doneAt: r.doneAt ? r.doneAt.toISOString() : null,
  };
}

export const assignmentsRouter = new Hono()
  .get('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('assignments handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const db = getDb();
    const caller = await loadCallerMember(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    const rows = await db
      .select({
        id: assignments.id,
        title: assignments.title,
        notes: assignments.notes,
        dueDate: assignments.dueDate,
        memberId: assignments.memberId,
        doneAt: assignments.doneAt,
      })
      .from(assignments)
      .where(eq(assignments.tenantId, tenantId))
      .orderBy(asc(assignments.dueDate), asc(assignments.createdAt));
    const response: ListAssignmentsResponse = { assignments: rows.map(rowToItem) };
    return c.json(listAssignmentsResponseSchema.parse(response));
  })
  .post('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('assignments handler reached without userRow');
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
      return c.json(
        { error: 'forbidden', detail: 'only admins and adults can add assignments' },
        403,
      );
    }
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = createAssignmentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    if (parsed.data.dueDate && parsed.data.dueDate < earliestAllowedDueDate()) {
      return c.json(PAST_DUE_DATE, 400);
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
      .insert(assignments)
      .values({
        tenantId,
        title: parsed.data.title,
        dueDate: parsed.data.dueDate ?? null,
        memberId: parsed.data.memberId ?? null,
        notes: parsed.data.notes ?? null,
      })
      .returning({
        id: assignments.id,
        title: assignments.title,
        notes: assignments.notes,
        dueDate: assignments.dueDate,
        memberId: assignments.memberId,
        doneAt: assignments.doneAt,
      });
    if (!row) return c.json({ error: 'insert failed', errorCode: 'ASSIGNMENT_INSERT_NO_ROW' }, 500);
    return c.json(assignmentItemSchema.parse(rowToItem(row)), 201);
  })
  .patch('/:id', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('assignments handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'invalid id', detail: 'assignment id must be a UUID' }, 400);
    }
    const db = getDb();
    const caller = await loadCallerMember(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    if (!WRITE_ROLES.has(caller.role)) {
      return c.json(
        { error: 'forbidden', detail: 'only admins and adults can edit assignments' },
        403,
      );
    }
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = patchAssignmentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const now = new Date();
    const [row] = await db
      .update(assignments)
      .set({ doneAt: parsed.data.done ? now : null, updatedAt: now })
      .where(and(eq(assignments.tenantId, tenantId), eq(assignments.id, id)))
      .returning({
        id: assignments.id,
        title: assignments.title,
        notes: assignments.notes,
        dueDate: assignments.dueDate,
        memberId: assignments.memberId,
        doneAt: assignments.doneAt,
      });
    if (!row) {
      return c.json({ error: 'not found', detail: 'assignment not found in this tenant' }, 404);
    }
    return c.json(assignmentItemSchema.parse(rowToItem(row)), 200);
  })
  // Edit an assignment's fields (title/notes/dueDate/assignee). Admin +
  // adult only; tenant-scoped. Completion state (doneAt) is owned by
  // PATCH and deliberately left untouched here so editing a done
  // assignment keeps it done.
  .put('/:id', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('assignments handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'invalid id', detail: 'assignment id must be a UUID' }, 400);
    }
    const db = getDb();
    const caller = await loadCallerMember(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    if (!WRITE_ROLES.has(caller.role)) {
      return c.json(
        { error: 'forbidden', detail: 'only admins and adults can edit assignments' },
        403,
      );
    }
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = createAssignmentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    // FHR-40: an already-overdue date may stay while other fields are
    // edited; only a newly chosen date has to be today or later.
    const newDue = parsed.data.dueDate ?? null;
    if (newDue && newDue < earliestAllowedDueDate()) {
      const [current] = await db
        .select({ dueDate: assignments.dueDate })
        .from(assignments)
        .where(and(eq(assignments.tenantId, tenantId), eq(assignments.id, id)))
        .limit(1);
      if (!current) {
        return c.json({ error: 'not found', detail: 'assignment not found in this tenant' }, 404);
      }
      if (current.dueDate !== newDue) return c.json(PAST_DUE_DATE, 400);
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
      .update(assignments)
      .set({
        title: parsed.data.title,
        dueDate: parsed.data.dueDate ?? null,
        memberId: parsed.data.memberId ?? null,
        notes: parsed.data.notes ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(assignments.tenantId, tenantId), eq(assignments.id, id)))
      .returning({
        id: assignments.id,
        title: assignments.title,
        notes: assignments.notes,
        dueDate: assignments.dueDate,
        memberId: assignments.memberId,
        doneAt: assignments.doneAt,
      });
    if (!row) {
      return c.json({ error: 'not found', detail: 'assignment not found in this tenant' }, 404);
    }
    return c.json(assignmentItemSchema.parse(rowToItem(row)), 200);
  })
  // FHR-41: remove an assignment for good. Admin + adult only; tenant-scoped.
  .delete('/:id', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('assignments handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'invalid id', detail: 'assignment id must be a UUID' }, 400);
    }
    const db = getDb();
    const caller = await loadCallerMember(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    if (!WRITE_ROLES.has(caller.role)) {
      return c.json(
        { error: 'forbidden', detail: 'only admins and adults can delete assignments' },
        403,
      );
    }
    const deleted = await db
      .delete(assignments)
      .where(and(eq(assignments.tenantId, tenantId), eq(assignments.id, id)))
      .returning({ id: assignments.id });
    if (deleted.length === 0) {
      return c.json({ error: 'not found', detail: 'assignment not found in this tenant' }, 404);
    }
    return c.body(null, 204);
  });
