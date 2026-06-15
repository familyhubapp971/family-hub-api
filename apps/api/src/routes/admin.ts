import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { appSettings, members } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';

// FHS-308 — Admin Panel: app_settings endpoints (tenant-scoped key/value config).
//
// GET  /api/admin/settings        → { [key]: value } map for the tenant.
// PUT  /api/admin/settings/:key   → upsert a setting; admin/adult only.
//
// Auth chain:
//   1. authenticated user (JWT)
//   2. tenant context (400 TENANT_REQUIRED if missing)
//   3. caller must be a member of this tenant (403)
//   4. for mutations: caller must be admin or adult (403)

type Db = ReturnType<typeof getDb>;

async function loadCaller(
  db: Db,
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

function isAdminOrAdult(caller: { role: string }): boolean {
  return caller.role === 'admin' || caller.role === 'adult';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function guardTenant(
  c: any,
): Promise<{ db: Db; tenantId: string; caller: { id: string; role: string } } | { res: Response }> {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) throw new Error('admin handler reached without userRow');
  const tenantId = c.get('tenantId') as string | undefined;
  if (!tenantId) {
    return { res: c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400) };
  }
  const db = getDb();
  const caller = await loadCaller(db, tenantId, userRow.id);
  if (!caller) {
    return { res: c.json({ error: 'forbidden', detail: 'caller is not a member' }, 403) };
  }
  return { db, tenantId, caller };
}

export const adminRouter = new Hono()
  // GET /api/admin/settings — full settings map for this tenant.
  .get('/settings', async (c) => {
    const ctx = await guardTenant(c);
    if ('res' in ctx) return ctx.res;
    const { db, tenantId } = ctx;

    const rows = await db
      .select({ key: appSettings.key, value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.tenantId, tenantId));

    const map: Record<string, unknown> = {};
    for (const row of rows) {
      map[row.key] = row.value;
    }
    return c.json(map);
  })

  // PUT /api/admin/settings/:key — upsert a setting value; admin/adult only.
  .put('/settings/:key', async (c) => {
    const ctx = await guardTenant(c);
    if ('res' in ctx) return ctx.res;
    const { db, tenantId, caller } = ctx;

    if (!isAdminOrAdult(caller)) {
      return c.json({ error: 'forbidden', detail: 'admin or adult role required' }, 403);
    }

    const key = c.req.param('key');
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = z.object({ value: z.string() }).safeParse(body);
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
      .insert(appSettings)
      .values({ tenantId, key, value: parsed.data.value, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [appSettings.tenantId, appSettings.key],
        set: { value: parsed.data.value, updatedAt: now },
      })
      .returning();

    return c.json(row);
  });
