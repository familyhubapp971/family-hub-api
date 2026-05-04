import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { members, tasks } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';

// FHS-233 — GET / POST / PATCH / DELETE /api/tasks.
//
// Per-member personal to-do list (NOT family-wide; that's
// /api/assignments). Tasks are private to the assigned member; only
// that member can see / mutate them. Children/teens included — kids
// manage their own to-dos here.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const taskItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  dueDate: z.string().regex(ISO_DATE).nullable(),
  done: z.boolean(),
  doneAt: z.string().datetime().nullable(),
});

export const listTasksResponseSchema = z.object({
  tasks: z.array(taskItemSchema),
});

export type ListTasksResponse = z.infer<typeof listTasksResponseSchema>;

const createTaskRequestSchema = z.object({
  title: z.string().trim().min(1, 'title is required').max(200),
  dueDate: z.string().regex(ISO_DATE, 'dueDate must be YYYY-MM-DD').nullish(),
});

const patchTaskRequestSchema = z.object({
  done: z.boolean(),
});

async function loadCallerMember(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  userId: string,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

function rowToItem(r: { id: string; title: string; dueDate: string | null; doneAt: Date | null }) {
  return {
    id: r.id,
    title: r.title,
    dueDate: r.dueDate,
    done: r.doneAt !== null,
    doneAt: r.doneAt ? r.doneAt.toISOString() : null,
  };
}

export const tasksRouter = new Hono()
  .get('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('tasks handler reached without userRow');
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
        id: tasks.id,
        title: tasks.title,
        dueDate: tasks.dueDate,
        doneAt: tasks.doneAt,
      })
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.memberId, caller.id)))
      .orderBy(desc(tasks.createdAt));
    return c.json(listTasksResponseSchema.parse({ tasks: rows.map(rowToItem) }));
  })
  .post('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('tasks handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const db = getDb();
    const caller = await loadCallerMember(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = createTaskRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const [row] = await db
      .insert(tasks)
      .values({
        tenantId,
        memberId: caller.id,
        title: parsed.data.title,
        dueDate: parsed.data.dueDate ?? null,
      })
      .returning({
        id: tasks.id,
        title: tasks.title,
        dueDate: tasks.dueDate,
        doneAt: tasks.doneAt,
      });
    if (!row) return c.json({ error: 'insert failed', errorCode: 'TASK_INSERT_NO_ROW' }, 500);
    return c.json(taskItemSchema.parse(rowToItem(row)), 201);
  })
  .patch('/:id', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('tasks handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const db = getDb();
    const caller = await loadCallerMember(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'invalid id', detail: 'task id must be a UUID' }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = patchTaskRequestSchema.safeParse(body);
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
    // The WHERE includes member_id == caller.id so a member can never
    // PATCH another member's task — even within the same tenant.
    const [row] = await db
      .update(tasks)
      .set({ doneAt: parsed.data.done ? now : null, updatedAt: now })
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.memberId, caller.id), eq(tasks.id, id)))
      .returning({
        id: tasks.id,
        title: tasks.title,
        dueDate: tasks.dueDate,
        doneAt: tasks.doneAt,
      });
    if (!row) {
      // 404 here covers BOTH "wrong owner" and "doesn't exist" — by
      // design. Splitting into 403/404 would let a probe enumerate
      // task ids belonging to other members. Same shape used in
      // DELETE below; do not split.
      return c.json({ error: 'not found', detail: 'task not found for this caller' }, 404);
    }
    return c.json(taskItemSchema.parse(rowToItem(row)), 200);
  })
  .delete('/:id', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('tasks handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const db = getDb();
    const caller = await loadCallerMember(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'invalid id', detail: 'task id must be a UUID' }, 400);
    }
    const deleted = await db
      .delete(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.memberId, caller.id), eq(tasks.id, id)))
      .returning({ id: tasks.id });
    if (deleted.length === 0) {
      return c.json({ error: 'not found', detail: 'task not found for this caller' }, 404);
    }
    return c.body(null, 204);
  });
