import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adminRouter } from '../../../../apps/api/src/routes/admin.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-343 — the Admin Panel settings endpoint is admin-only. GET is readable by
// any member; PUT (mutating a setting) requires the admin role.
//
// FHS-441 — `currency` is a special key in this same map: GET merges
// tenants.currency in; PUT writes straight to tenants.currency instead of
// upserting an app_settings row.

const dbMock = { select: vi.fn(), insert: vi.fn(), update: vi.fn() };
vi.mock('../../../../apps/api/src/db/client.js', () => ({ getDb: () => dbMock }));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const FIXED_USER: User = {
  id: USER_ID,
  email: 's@e.com',
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: new Date('2026-06-01T00:00:00.000Z'),
};

// A thenable that resolves to `rows` no matter where the builder chain stops
// (mirrors the pattern used in dashboard.test.ts) — needed because GET
// /api/admin/settings awaits `.from().where()` directly (no `.limit()`),
// while loadCaller() awaits `.from().where().limit()`.
function chain(rows: unknown): unknown {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    limit: () => obj,
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return obj;
}

interface SeedOpts {
  callerRole: string | null;
  appSettingsRows?: Array<{ key: string; value: unknown }>;
  tenantCurrency?: string | null;
}

function buildApp(opts: SeedOpts) {
  const { callerRole, appSettingsRows = [], tenantCurrency = 'USD' } = opts;
  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: 's@e.com', claims: {} });
    c.set('userRow', FIXED_USER);
    c.set('tenantId', TENANT_ID);
    await next();
  };

  // Call order: 1 = loadCaller (guardTenant). For GET, calls 2 and 3 are the
  // Promise.all([app_settings rows, tenant currency row]).
  let idx = 0;
  dbMock.select.mockImplementation(() => {
    idx += 1;
    if (idx === 1) {
      return chain(callerRole ? [{ id: 'm1', role: callerRole }] : []);
    }
    if (idx === 2) return chain(appSettingsRows);
    return chain(tenantCurrency === null ? [] : [{ currency: tenantCurrency }]);
  });

  dbMock.insert.mockImplementation(() => ({
    values: () => ({
      onConflictDoUpdate: () => ({ returning: () => Promise.resolve([{ key: 'k', value: 'v' }]) }),
    }),
  }));

  // Captures the value passed to .set() so PUT /settings/currency tests can
  // assert the tenants.currency row was actually updated with it.
  let lastSetCurrency: string | undefined;
  dbMock.update.mockImplementation(() => ({
    set: (values: { currency?: string }) => {
      lastSetCurrency = values.currency;
      return {
        where: () => ({
          returning: () => Promise.resolve([{ currency: lastSetCurrency }]),
        }),
      };
    },
  }));

  const app = new Hono();
  app.use('*', seed);
  app.route('/api/admin', adminRouter);
  return app;
}

const put = (value: string): RequestInit => ({
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ value }),
});

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
  dbMock.update.mockReset();
});

describe('FHS-343 — PUT /api/admin/settings/:key is admin-only', () => {
  it('403 when the caller is not a member', async () => {
    const res = await buildApp({ callerRole: null }).request(
      '/api/admin/settings/theme',
      put('dark'),
    );
    expect(res.status).toBe(403);
  });
  it('403 ADMIN_ONLY for a normal user (adult)', async () => {
    const res = await buildApp({ callerRole: 'adult' }).request(
      '/api/admin/settings/theme',
      put('dark'),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe('ADMIN_ONLY');
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
  it('200 for an admin', async () => {
    const res = await buildApp({ callerRole: 'admin' }).request(
      '/api/admin/settings/theme',
      put('dark'),
    );
    expect(res.status).toBe(200);
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });
});

describe('FHS-441 — GET /api/admin/settings merges in tenants.currency', () => {
  it('includes currency alongside the app_settings map', async () => {
    const app = buildApp({
      callerRole: 'admin',
      appSettingsRows: [{ key: 'appName', value: 'Iman World' }],
      tenantCurrency: 'AED',
    });
    const res = await app.request('/api/admin/settings');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ appName: 'Iman World', currency: 'AED' });
  });

  it('defaults currency to USD when the tenant row is somehow missing', async () => {
    const app = buildApp({ callerRole: 'admin', tenantCurrency: null });
    const res = await app.request('/api/admin/settings');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['currency']).toBe('USD');
  });

  it('is readable by any member, not just admins', async () => {
    const app = buildApp({ callerRole: 'child', tenantCurrency: 'GBP' });
    const res = await app.request('/api/admin/settings');
    expect(res.status).toBe(200);
  });

  it('403 when the caller is not a tenant member', async () => {
    const app = buildApp({ callerRole: null });
    const res = await app.request('/api/admin/settings');
    expect(res.status).toBe(403);
  });
});

describe('FHS-441 — PUT /api/admin/settings/currency writes tenants.currency', () => {
  it('403 ADMIN_ONLY for a normal user (adult)', async () => {
    const app = buildApp({ callerRole: 'adult' });
    const res = await app.request('/api/admin/settings/currency', put('GBP'));
    expect(res.status).toBe(403);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('200 for an admin — updates tenants.currency, not app_settings', async () => {
    const app = buildApp({ callerRole: 'admin' });
    const res = await app.request('/api/admin/settings/currency', put('GBP'));
    expect(res.status).toBe(200);
    expect(dbMock.update).toHaveBeenCalledTimes(1);
    expect(dbMock.insert).not.toHaveBeenCalled();
    const body = (await res.json()) as { key: string; value: string };
    expect(body).toEqual({ key: 'currency', value: 'GBP' });
  });

  it('400 for a lowercase or non-3-letter currency code', async () => {
    // Fresh app per request — the select() mock is call-indexed per app
    // instance (loadCaller is call #1), so reusing one app across two
    // requests would misread the second loadCaller call as settings data.
    const lowercase = await buildApp({ callerRole: 'admin' }).request(
      '/api/admin/settings/currency',
      put('gbp'),
    );
    expect(lowercase.status).toBe(400);
    const tooLong = await buildApp({ callerRole: 'admin' }).request(
      '/api/admin/settings/currency',
      put('GBPX'),
    );
    expect(tooLong.status).toBe(400);
    expect(dbMock.update).not.toHaveBeenCalled();
  });
});
