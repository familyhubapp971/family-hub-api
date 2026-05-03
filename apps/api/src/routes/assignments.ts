import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { assignments, members } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';

// FHS-231 — GET / POST / PATCH /api/assignments.
//
// Backs the Assignments tab. Per-family homework / chore list.
// GET: returns every assignment, ordered by due date (NULLs last) then
// created_at — open / overdue assignments sit on top, undated tasks
// trail behind.
// POST: create one assignment (admin/adult only).
// PATCH /:id: toggle done (admin/adult only). Body: { done: boolean }.
// `done` true sets done_at = now(); false clears it.

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

const createAssignmentRequestSchema = z.object({
  title: z.string().trim().min(1, 'title is required').max(200),
  dueDate: z.string().regex(ISO_DATE, 'dueDate must be YYYY-MM-DD').nullish(),
  memberId: z.string().uuid().nullish(),
  notes: z.string().max(1000).nullish(),
});

const patchAssignmentRequestSchema = z.object({
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
  });
