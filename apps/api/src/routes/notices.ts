import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { members, notices } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';

// FHS-232 — GET / POST / DELETE /api/notices.
//
// Backs the Noticeboard tab. Family bulletin board: short notes,
// optionally pinned. Pinned notes float to the top, rest is
// reverse-chronological. POST and DELETE are admin/adult only.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const noticeItemSchema = z.object({
  id: z.string().uuid(),
  body: z.string(),
  pinned: z.boolean(),
  authorMemberId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
});

export const listNoticesResponseSchema = z.object({
  notices: z.array(noticeItemSchema),
});

export type ListNoticesResponse = z.infer<typeof listNoticesResponseSchema>;

const createNoticeRequestSchema = z.object({
  body: z.string().trim().min(1, 'body is required').max(2000),
  pinned: z.boolean().optional(),
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
  body: string;
  pinned: boolean;
  authorMemberId: string | null;
  createdAt: Date;
}) {
  return {
    id: r.id,
    body: r.body,
    pinned: r.pinned,
    authorMemberId: r.authorMemberId,
    createdAt: r.createdAt.toISOString(),
  };
}

export const noticesRouter = new Hono()
  .get('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('notices handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const db = getDb();
    const caller = await loadCallerMember(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    // Pinned first (true sorts before false when DESC), then newest first.
    const rows = await db
      .select({
        id: notices.id,
        body: notices.body,
        pinned: notices.pinned,
        authorMemberId: notices.authorMemberId,
        createdAt: notices.createdAt,
      })
      .from(notices)
      .where(eq(notices.tenantId, tenantId))
      .orderBy(desc(notices.pinned), desc(notices.createdAt));
    return c.json(listNoticesResponseSchema.parse({ notices: rows.map(rowToItem) }));
  })
  .post('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('notices handler reached without userRow');
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
      return c.json({ error: 'forbidden', detail: 'only admins and adults can post notices' }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = createNoticeRequestSchema.safeParse(body);
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
      .insert(notices)
      .values({
        tenantId,
        body: parsed.data.body,
        pinned: parsed.data.pinned ?? false,
        authorMemberId: caller.id,
      })
      .returning({
        id: notices.id,
        body: notices.body,
        pinned: notices.pinned,
        authorMemberId: notices.authorMemberId,
        createdAt: notices.createdAt,
      });
    if (!row) return c.json({ error: 'insert failed', errorCode: 'NOTICE_INSERT_NO_ROW' }, 500);
    return c.json(noticeItemSchema.parse(rowToItem(row)), 201);
  })
  .delete('/:id', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('notices handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const db = getDb();
    // Auth + role gate run BEFORE the UUID format check so a non-member
    // hitting this route with garbage in the id never learns whether
    // the route exists or not. Same shape as GET/POST.
    const caller = await loadCallerMember(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    if (!WRITE_ROLES.has(caller.role)) {
      return c.json(
        { error: 'forbidden', detail: 'only admins and adults can delete notices' },
        403,
      );
    }
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'invalid id', detail: 'notice id must be a UUID' }, 400);
    }
    const deleted = await db
      .delete(notices)
      .where(and(eq(notices.tenantId, tenantId), eq(notices.id, id)))
      .returning({ id: notices.id });
    if (deleted.length === 0) {
      return c.json({ error: 'not found', detail: 'notice not found in this tenant' }, 404);
    }
    return c.body(null, 204);
  });
