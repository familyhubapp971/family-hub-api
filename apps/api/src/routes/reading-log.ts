import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { readingLog, members } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';

// Learn Phase 1 — GET/POST/PATCH/DELETE /api/reading-log.
//
// A child's personal book list. Auth mirrors the journal/learn pattern:
// a child accesses only their own entries; an admin or adult can access any
// member's entries in the same tenant.

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const memberQuerySchema = z.object({ memberId: z.string().uuid() });

const createBookSchema = z.object({
  memberId: z.string().uuid(),
  title: z.string().min(1).max(200),
  author: z.string().max(120).optional(),
});

const patchBookSchema = z.object({
  memberId: z.string().uuid(),
  finished: z.boolean(),
});

// Shape returned for each book in list + create responses.
const bookSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  author: z.string().nullable(),
  finished: z.boolean(),
  createdAt: z.string().datetime(),
});

export const listBooksResponseSchema = z.object({ books: z.array(bookSchema) });

// ─── Auth helpers (same pattern as journal + learn) ───────────────────────────

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

// ─── Router ───────────────────────────────────────────────────────────────────

export const readingLogRouter = new Hono()

  // GET /?memberId= — newest-first list for a member.
  .get('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('reading-log GET handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const parsed = memberQuerySchema.safeParse({ memberId: c.req.query('memberId') });
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
    const caller = await loadCaller(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    if (!(await memberInTenant(db, tenantId, parsed.data.memberId))) {
      return c.json({ error: 'not found', detail: 'member not found in this tenant' }, 404);
    }
    if (!canManage(caller, parsed.data.memberId)) {
      return c.json({ error: 'forbidden', detail: 'not allowed for this member' }, 403);
    }
    const rows = await db
      .select({
        id: readingLog.id,
        title: readingLog.title,
        author: readingLog.author,
        finished: readingLog.finished,
        createdAt: readingLog.createdAt,
      })
      .from(readingLog)
      .where(and(eq(readingLog.tenantId, tenantId), eq(readingLog.memberId, parsed.data.memberId)))
      .orderBy(desc(readingLog.createdAt));
    return c.json(
      listBooksResponseSchema.parse({
        books: rows.map((r) => ({
          ...r,
          author: r.author ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
      }),
    );
  })

  // POST / — add a book (returns 201 + created book).
  .post('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('reading-log POST handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const rawBody = (await c.req.json().catch(() => null)) as unknown;
    const parsed = createBookSchema.safeParse(rawBody);
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
    const caller = await loadCaller(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    if (!(await memberInTenant(db, tenantId, parsed.data.memberId))) {
      return c.json({ error: 'not found', detail: 'member not found in this tenant' }, 404);
    }
    if (!canManage(caller, parsed.data.memberId)) {
      return c.json({ error: 'forbidden', detail: 'not allowed for this member' }, 403);
    }
    const [row] = await db
      .insert(readingLog)
      .values({
        tenantId,
        memberId: parsed.data.memberId,
        title: parsed.data.title,
        author: parsed.data.author ?? null,
      })
      .returning();
    if (!row) return c.json({ error: 'insert failed' }, 500);
    return c.json(
      bookSchema.parse({
        id: row.id,
        title: row.title,
        author: row.author ?? null,
        finished: row.finished,
        createdAt: row.createdAt.toISOString(),
      }),
      201,
    );
  })

  // PATCH /:id — toggle finished. Body: { memberId, finished }.
  .patch('/:id', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('reading-log PATCH handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const bookId = c.req.param('id');
    const rawBody = (await c.req.json().catch(() => null)) as unknown;
    const parsed = patchBookSchema.safeParse(rawBody);
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
    const caller = await loadCaller(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    if (!(await memberInTenant(db, tenantId, parsed.data.memberId))) {
      return c.json({ error: 'not found', detail: 'member not found in this tenant' }, 404);
    }
    if (!canManage(caller, parsed.data.memberId)) {
      return c.json({ error: 'forbidden', detail: 'not allowed for this member' }, 403);
    }
    const [updated] = await db
      .update(readingLog)
      .set({ finished: parsed.data.finished, updatedAt: new Date() })
      .where(
        and(
          eq(readingLog.id, bookId),
          eq(readingLog.tenantId, tenantId),
          eq(readingLog.memberId, parsed.data.memberId),
        ),
      )
      .returning();
    if (!updated) return c.json({ error: 'not found' }, 404);
    return c.json(
      bookSchema.parse({
        id: updated.id,
        title: updated.title,
        author: updated.author ?? null,
        finished: updated.finished,
        createdAt: updated.createdAt.toISOString(),
      }),
    );
  })

  // DELETE /:id?memberId= — remove a book (204).
  .delete('/:id', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('reading-log DELETE handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const bookId = c.req.param('id');
    const parsed = memberQuerySchema.safeParse({ memberId: c.req.query('memberId') });
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
    const caller = await loadCaller(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    if (!(await memberInTenant(db, tenantId, parsed.data.memberId))) {
      return c.json({ error: 'not found', detail: 'member not found in this tenant' }, 404);
    }
    if (!canManage(caller, parsed.data.memberId)) {
      return c.json({ error: 'forbidden', detail: 'not allowed for this member' }, 403);
    }
    await db
      .delete(readingLog)
      .where(
        and(
          eq(readingLog.id, bookId),
          eq(readingLog.tenantId, tenantId),
          eq(readingLog.memberId, parsed.data.memberId),
        ),
      );
    return new Response(null, { status: 204 });
  });
