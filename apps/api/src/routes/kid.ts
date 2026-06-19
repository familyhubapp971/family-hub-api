import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { kidAuthMiddleware, requireKidAuth, getKidAuth } from '../middleware/kid-auth.js';
import { getDb, pinRequestTenant } from '../db/client.js';
import { habits } from '../db/schema.js';
import { listTenantNotices, listNoticesResponseSchema } from './notices.js';
import { listTasksForMember, setTaskDoneForMember, taskItemSchema } from './tasks.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const kidTasksResponseSchema = z.object({ tasks: z.array(taskItemSchema) });
const kidTaskPatchSchema = z.object({ done: z.boolean() });

export const kidTodayResponseSchema = z.object({
  habits: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      icon: z.string().nullable(),
      color: z.string(),
    }),
  ),
});

// FHS-257 / FHS-355 — kid-scoped API surface.
//
// Mounted at /api/kid behind [kidAuthMiddleware, requireKidAuth] so every
// handler here can rely on a verified kid principal via getKidAuth(c). The
// parent Supabase auth middleware skips /api/kid (it's listed in that
// middleware's public prefixes), so a kid token never has to survive the ES256
// path. Every read is scoped to the kid's OWN tenant/member from the verified
// token — never a slug/header — so a kid can only ever see their own family.

export const kidMeResponseSchema = z.object({
  memberId: z.string().uuid(),
  tenantId: z.string().uuid(),
  tenantSlug: z.string().min(1),
});

export const kidRouter = new Hono()
  .use('*', kidAuthMiddleware())
  .use('*', requireKidAuth)
  .get('/me', (c) => {
    // No DB — just echoes the verified token claims, so no tenant pin here.
    const kid = getKidAuth(c);
    return c.json(kidMeResponseSchema.parse(kid));
  })
  // FHS-355 — the family noticeboard, scoped to the kid's own tenant from the
  // verified kid token. FHS-354 — pin that tenant so the read passes RLS once
  // the app runs as app_runtime (the token, not resolveTenant, is the source).
  .get('/notices', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const notices = await listTenantNotices(getDb(), kid.tenantId);
    return c.json(listNoticesResponseSchema.parse({ notices }));
  })
  // FHS-355 — the kid's OWN tasks (member-scoped from the kid token).
  .get('/tasks', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const tasks = await listTasksForMember(getDb(), kid.tenantId, kid.memberId);
    return c.json(kidTasksResponseSchema.parse({ tasks }));
  })
  // FHS-355 — tick/untick one of the kid's OWN tasks. The member+tenant guard in
  // setTaskDoneForMember means a kid can never touch another member's task.
  .patch('/tasks/:id', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'invalid id', detail: 'task id must be a UUID' }, 400);
    }
    const parsed = kidTaskPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const ok = await setTaskDoneForMember(
      getDb(),
      kid.tenantId,
      kid.memberId,
      id,
      parsed.data.done,
    );
    if (!ok) {
      return c.json({ error: 'not found', detail: 'no such task for this kid' }, 404);
    }
    return c.json({ ok: true });
  })
  // FHS-355 — the kid's "Today": their own active habits (member-scoped). A
  // read-only at-a-glance list; full sticker interaction is a follow-up.
  .get('/today', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const rows = await getDb()
      .select({
        id: habits.id,
        name: habits.name,
        icon: habits.icon,
        color: habits.color,
      })
      .from(habits)
      .where(
        and(
          eq(habits.tenantId, kid.tenantId),
          eq(habits.memberId, kid.memberId),
          isNull(habits.archivedAt),
        ),
      )
      .orderBy(asc(habits.createdAt));
    return c.json(kidTodayResponseSchema.parse({ habits: rows }));
  });
