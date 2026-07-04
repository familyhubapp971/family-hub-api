import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { appSettings, tenants } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { loadCaller, isAdmin } from '../lib/permissions.js';

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
//
// FHS-441 — `currency` is a special key in this same map: unlike appName /
// appSubtitle (which live in the generic app_settings key/value table), the
// family's currency is the `tenants.currency` column — the single source of
// truth every other endpoint already reads (habits, kid, mw-financial, …).
// GET merges it in; PUT writes straight to `tenants` instead of app_settings
// so nothing else in the app has to learn about a second currency source.

// ISO 4217 currency — three uppercase letters (same rule as onboarding's
// currencySchema in routes/onboarding.ts).
const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code');

export const adminSettingsResponseSchema = z.record(z.string(), z.string());
export const adminSettingsPutRequestSchema = z.object({ value: z.string() });
export const adminSettingsPutResponseSchema = z.object({ key: z.string() }).passthrough();

type Db = ReturnType<typeof getDb>;

async function guardTenant(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  // GET /api/admin/settings — full settings map for this tenant, plus the
  // tenant's currency (FHS-441) merged in under the `currency` key.
  .get('/settings', async (c) => {
    const ctx = await guardTenant(c);
    if ('res' in ctx) return ctx.res;
    const { db, tenantId } = ctx;

    const [rows, [tenantRow]] = await Promise.all([
      db
        .select({ key: appSettings.key, value: appSettings.value })
        .from(appSettings)
        .where(eq(appSettings.tenantId, tenantId)),
      db.select({ currency: tenants.currency }).from(tenants).where(eq(tenants.id, tenantId)),
    ]);

    const map: Record<string, unknown> = {};
    for (const row of rows) {
      map[row.key] = row.value;
    }
    map['currency'] = tenantRow?.currency ?? 'USD';
    return c.json(map);
  })

  // PUT /api/admin/settings/:key — upsert a setting value; admin-only (FHS-343).
  // FHS-441 — `currency` writes to tenants.currency instead of app_settings.
  .put('/settings/:key', async (c) => {
    const ctx = await guardTenant(c);
    if ('res' in ctx) return ctx.res;
    const { db, tenantId, caller } = ctx;

    if (!isAdmin(caller)) {
      return c.json(
        { error: 'forbidden', errorCode: 'ADMIN_ONLY', detail: 'admin role required' },
        403,
      );
    }

    const key = c.req.param('key');
    const body = (await c.req.json().catch(() => null)) as unknown;

    if (key === 'currency') {
      const parsed = z.object({ value: currencySchema }).safeParse(body);
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
      const [row] = await db
        .update(tenants)
        .set({ currency: parsed.data.value, updatedAt: new Date() })
        .where(eq(tenants.id, tenantId))
        .returning({ currency: tenants.currency });
      return c.json({ key: 'currency', value: row?.currency ?? parsed.data.value });
    }

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
