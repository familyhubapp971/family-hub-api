import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { members, tasks } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';

// FHS-233 / FHS-267 — GET / POST / PATCH / DELETE /api/tasks.
//
// The Tasks tab is a shared-to-see, private-to-edit family board
// (ADR 0013). GET returns every task in the tenant tagged with its
// memberId so the UI can render a column per person; POST/PATCH/DELETE
// stay owner-scoped — a member can see another's column but can only
// mutate their own tasks. (Distinct from /api/assignments, the
// family homework surface.)

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const taskItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  dueDate: z.string().regex(ISO_DATE).nullable(),
  memberId: z.string().uuid(),
  done: z.boolean(),
  doneAt: z.string().datetime().nullable(),
});

export const listTasksResponseSchema = z.object({
  tasks: z.array(taskItemSchema),
  callerMemberId: z.string().uuid(),
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

function rowToItem(r: {
  id: string;
  title: string;
  dueDate: string | null;
  memberId: string;
  doneAt: Date | null;
}) {
  return {
    id: r.id,
    title: r.title,
    dueDate: r.dueDate,
    memberId: r.memberId,
    done: r.doneAt !== null,
    doneAt: r.doneAt ? r.doneAt.toISOString() : null,
  };
}

// FHS-355 — the kid's OWN tasks, newest first. Shared by the kid route
// (GET /api/kid/tasks). Member-scoped so a kid only ever sees their own.
export async function listTasksForMember(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  memberId: string,
) {
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      dueDate: tasks.dueDate,
      memberId: tasks.memberId,
      doneAt: tasks.doneAt,
    })
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.memberId, memberId)))
    .orderBy(desc(tasks.createdAt));
  return rows.map(rowToItem);
}

// FHS-355 — tick/untick one of the member's OWN tasks. Returns false if no task
// matched (wrong id, other member, or other tenant) so the caller can 404.
export async function setTaskDoneForMember(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  memberId: string,
  taskId: string,
  done: boolean,
): Promise<boolean> {
  const updated = await db
    .update(tasks)
    .set({ doneAt: done ? new Date() : null, updatedAt: new Date() })
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId), eq(tasks.memberId, memberId)))
    .returning({ id: tasks.id });
  return updated.length > 0;
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
    // Family-wide read (ADR 0013): every member's tasks, grouped by
    // member then newest-first, so the UI renders a column per person.
    const rows = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        dueDate: tasks.dueDate,
        memberId: tasks.memberId,
        doneAt: tasks.doneAt,
      })
      .from(tasks)
      .where(eq(tasks.tenantId, tenantId))
      .orderBy(asc(tasks.memberId), desc(tasks.createdAt));
    return c.json(
      listTasksResponseSchema.parse({ tasks: rows.map(rowToItem), callerMemberId: caller.id }),
    );
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
        memberId: tasks.memberId,
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
        memberId: tasks.memberId,
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
  })
  // Edit a task's title/due date. Owner-scoped (a member edits only their
  // own tasks) — same WHERE as PATCH/DELETE. memberId and completion
  // (doneAt) are deliberately not editable here.
  .put('/:id', async (c) => {
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
      .update(tasks)
      .set({
        title: parsed.data.title,
        dueDate: parsed.data.dueDate ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.memberId, caller.id), eq(tasks.id, id)))
      .returning({
        id: tasks.id,
        title: tasks.title,
        dueDate: tasks.dueDate,
        memberId: tasks.memberId,
        doneAt: tasks.doneAt,
      });
    if (!row) {
      return c.json({ error: 'not found', detail: 'task not found for this caller' }, 404);
    }
    return c.json(taskItemSchema.parse(rowToItem(row)), 200);
  });
