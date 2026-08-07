import { Hono } from 'hono';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { getDb } from '../db/client.js';
import { appSettings, tenants, TENANT_SCOPED_TABLES } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { loadCaller, isAdmin } from '../lib/permissions.js';

// FHS-308: Admin Panel: app_settings endpoints (tenant-scoped key/value config).
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
// FHS-441: `currency` is a special key in this same map: unlike appName /
// appSubtitle (which live in the generic app_settings key/value table), the
// family's currency is the `tenants.currency` column: the single source of
// truth every other endpoint already reads (habits, kid, mw-financial, …).
// GET merges it in; PUT writes straight to `tenants` instead of app_settings
// so nothing else in the app has to learn about a second currency source.

// ISO 4217 currency: three uppercase letters (same rule as onboarding's
// currencySchema in routes/onboarding.ts).
const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code');

// FHS-626: the family's own name. It lives on the tenant row, like the
// currency, not in the loose settings map, so it gets the same treatment.
// The family's web address is its slug and is deliberately NOT touched:
// renaming must never break a saved link.
const familyNameSchema = z
  .string()
  .trim()
  .min(1, 'family name cannot be empty')
  .max(80, 'family name is too long');

export const adminSettingsResponseSchema = z.record(z.string(), z.string());
export const adminSettingsPutRequestSchema = z.object({ value: z.string() });
export const adminSettingsPutResponseSchema = z.object({ key: z.string() }).passthrough();

// FHS-435: GDPR: export my data + delete my account.
//
// GET  /api/admin/export          → the whole family's data as one JSON file.
// POST /api/admin/delete-account  → IRREVERSIBLE. Deletes the tenant + every
//                                    row that belongs to it.
//
// Both admin-only (same guard chain as the settings PUT above): auth →
// tenant context → membership → isAdmin. Tenant always comes from the
// request context (`c.get('tenantId')`), never from the request body, so a
// caller can only ever export/delete the family they are an admin of.
export const adminExportFamilySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  status: z.string(),
  plan: z.string(),
  timezone: z.string(),
  currency: z.string(),
  onboardingCompleted: z.boolean(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
});
export const adminExportResponseSchema = z.object({
  exportedAt: z.string(),
  family: adminExportFamilySchema,
  // One key per tenant-scoped table (camelCase: e.g. `habitStickers`),
  // each an array of that table's raw rows for this tenant only.
  data: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});

export const adminDeleteAccountRequestSchema = z.object({
  // Must equal the tenant's exact name: the confirmation gate for an
  // irreversible action. Never delete without it matching.
  confirm: z.string().min(1, 'confirm is required'),
});
export const adminDeleteAccountResponseSchema = z.object({ deleted: z.literal(true) });

/** `mw_transaction_stickers` → `mwTransactionStickers` (matches the schema.ts export names). */
function toCamelCase(snakeCase: string): string {
  return snakeCase.replace(/_([a-z0-9])/g, (_match, c: string) => c.toUpperCase());
}

/**
 * `db.execute(sql...)` returns raw Postgres column names (snake_case, e.g.
 * `tenant_id`), unlike the typed query builder which camelCases them to
 * match schema.ts. Re-key every row so the export JSON matches the same
 * camelCase shape every other endpoint in this API returns.
 */
function camelizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[toCamelCase(key)] = value;
  }
  return out;
}

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
  // GET /api/admin/settings: full settings map for this tenant, plus the
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
      db
        .select({ currency: tenants.currency, name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantId)),
    ]);

    const map: Record<string, unknown> = {};
    for (const row of rows) {
      map[row.key] = row.value;
    }
    map['currency'] = tenantRow?.currency ?? 'USD';
    // FHS-626: surfaced so the settings screen can show and edit it.
    map['familyName'] = tenantRow?.name ?? '';
    return c.json(map);
  })

  // PUT /api/admin/settings/:key: upsert a setting value; admin-only (FHS-343).
  // FHS-441: `currency` writes to tenants.currency instead of app_settings.
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

    // FHS-626: renaming the family. Writes tenants.name, never the slug.
    if (key === 'familyName') {
      const parsed = z.object({ value: familyNameSchema }).safeParse(body);
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
        .set({ name: parsed.data.value, updatedAt: new Date() })
        .where(eq(tenants.id, tenantId))
        .returning({ name: tenants.name });
      return c.json({ key: 'familyName', value: row?.name ?? parsed.data.value });
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
  })

  // GET /api/admin/export: FHS-435: a single JSON download of this family's
  // data (GDPR data portability). Admin-only. Every table query is filtered
  // by the caller's own tenantId, so one family can never see another's data
  // through this endpoint.
  .get('/export', async (c) => {
    const ctx = await guardTenant(c);
    if ('res' in ctx) return ctx.res;
    const { db, tenantId, caller } = ctx;

    if (!isAdmin(caller)) {
      return c.json(
        { error: 'forbidden', errorCode: 'ADMIN_ONLY', detail: 'admin role required' },
        403,
      );
    }

    const [tenantRow] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!tenantRow) {
      return c.json({ error: 'tenant not found' }, 404);
    }

    const data: Record<string, unknown[]> = {};
    for (const table of TENANT_SCOPED_TABLES) {
      const name = getTableConfig(table).name;
      const result = await db.execute(
        sql`select * from ${sql.identifier(name)} where tenant_id = ${tenantId}`,
      );
      data[toCamelCase(name)] = result.rows.map((row) => {
        const camel = camelizeRow(row) as Record<string, unknown>;
        // FHS-435: never put the kid PIN hash in a downloadable export: a
        // 4-digit PIN is trivially brute-forceable, so the hash must not leave
        // the app in a file the family might share.
        delete camel.pinHash;
        return camel;
      });
    }

    const payload = {
      exportedAt: new Date().toISOString(),
      family: {
        id: tenantRow.id,
        slug: tenantRow.slug,
        name: tenantRow.name,
        status: tenantRow.status,
        plan: tenantRow.plan,
        timezone: tenantRow.timezone,
        currency: tenantRow.currency,
        onboardingCompleted: tenantRow.onboardingCompleted,
        createdAt: tenantRow.createdAt,
        updatedAt: tenantRow.updatedAt,
      },
      data,
    };

    const dateStamp = payload.exportedAt.slice(0, 10);
    c.header(
      'Content-Disposition',
      `attachment; filename="familyhub-export-${tenantRow.slug}-${dateStamp}.json"`,
    );
    return c.json(payload);
  })

  // POST /api/admin/delete-account: FHS-435: IRREVERSIBLE. Permanently
  // deletes the caller's family (tenant) and every row that belongs to it.
  //
  // Every tenant-scoped table's tenant_id foreign key is ON DELETE CASCADE
  // (schema.ts), so one DELETE on the tenants row cascades through all of
  // them: including tables that reference a tenant-scoped table rather
  // than tenants directly (e.g. mw_transaction_stickers), since Postgres
  // walks the whole FK graph. Referential-integrity cascades ALWAYS bypass
  // row-level security (this is documented Postgres behaviour), so this
  // works whether the connection is the limited app_runtime role or a test
  // superuser: RLS on the child tables can never block the cascade.
  //
  // Deleting the tenant also cascades the `members` rows for this tenant:
  // that's the users-mirror ↔ tenant membership link. The global `users`
  // rows (Supabase auth identity) are untouched: this endpoint does NOT
  // delete the Supabase auth user (that needs the service role): tracked
  // as a follow-up.
  .post('/delete-account', async (c) => {
    const ctx = await guardTenant(c);
    if ('res' in ctx) return ctx.res;
    const { db, tenantId, caller } = ctx;

    if (!isAdmin(caller)) {
      return c.json(
        { error: 'forbidden', errorCode: 'ADMIN_ONLY', detail: 'admin role required' },
        403,
      );
    }

    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = adminDeleteAccountRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }

    const [tenantRow] = await db
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!tenantRow) {
      return c.json({ error: 'tenant not found' }, 404);
    }

    // Confirmation gate: never delete without the caller typing the exact
    // family name. Trimmed on both sides so incidental leading/trailing
    // whitespace from copy-paste doesn't block a genuine match.
    if (parsed.data.confirm.trim() !== tenantRow.name.trim()) {
      return c.json(
        {
          error: 'confirmation mismatch',
          errorCode: 'CONFIRM_MISMATCH',
          detail: 'confirm must match the family name exactly',
        },
        400,
      );
    }

    await db.transaction(async (tx) => {
      await tx.delete(tenants).where(eq(tenants.id, tenantId));
    });

    return c.json({ deleted: true });
  });
