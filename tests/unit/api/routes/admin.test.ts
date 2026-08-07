import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adminRouter } from '../../../../apps/api/src/routes/admin.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-343: the Admin Panel settings endpoint is admin-only. GET is readable by
// any member; PUT (mutating a setting) requires the admin role.
//
// FHS-441: `currency` is a special key in this same map: GET merges
// tenants.currency in; PUT writes straight to tenants.currency instead of
// upserting an app_settings row.

const dbMock = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  execute: vi.fn(),
  delete: vi.fn(),
  transaction: vi.fn(),
};
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
// (mirrors the pattern used in dashboard.test.ts): needed because GET
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
    return chain(
      tenantCurrency === null ? [] : [{ currency: tenantCurrency, name: 'Khan Family' }],
    );
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
  dbMock.execute.mockReset();
  dbMock.delete.mockReset();
  dbMock.transaction.mockReset();
});

describe('FHS-343: PUT /api/admin/settings/:key is admin-only', () => {
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

describe('FHS-441: GET /api/admin/settings merges in tenants.currency', () => {
  it('includes currency alongside the app_settings map', async () => {
    const app = buildApp({
      callerRole: 'admin',
      appSettingsRows: [{ key: 'appName', value: 'Iman World' }],
      tenantCurrency: 'AED',
    });
    const res = await app.request('/api/admin/settings');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // FHS-626: the family's own name comes back too, so the settings screen
    // can show and edit it.
    expect(body).toEqual({ appName: 'Iman World', currency: 'AED', familyName: 'Khan Family' });
  });

  it('returns the family name so it can be edited (FHS-626)', async () => {
    const app = buildApp({ callerRole: 'admin', tenantCurrency: 'GBP' });
    const res = await app.request('/api/admin/settings');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['familyName']).toBe('Khan Family');
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

describe('FHS-441: PUT /api/admin/settings/currency writes tenants.currency', () => {
  it('403 ADMIN_ONLY for a normal user (adult)', async () => {
    const app = buildApp({ callerRole: 'adult' });
    const res = await app.request('/api/admin/settings/currency', put('GBP'));
    expect(res.status).toBe(403);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('200 for an admin: updates tenants.currency, not app_settings', async () => {
    const app = buildApp({ callerRole: 'admin' });
    const res = await app.request('/api/admin/settings/currency', put('GBP'));
    expect(res.status).toBe(200);
    expect(dbMock.update).toHaveBeenCalledTimes(1);
    expect(dbMock.insert).not.toHaveBeenCalled();
    const body = (await res.json()) as { key: string; value: string };
    expect(body).toEqual({ key: 'currency', value: 'GBP' });
  });

  it('400 for a lowercase or non-3-letter currency code', async () => {
    // Fresh app per request: the select() mock is call-indexed per app
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

// FHS-435: GDPR: export my data + delete my account.

const TENANT_ROW = {
  id: TENANT_ID,
  slug: 'khans',
  name: 'The Khans',
  status: 'active',
  plan: 'starter',
  timezone: 'UTC',
  currency: 'USD',
  onboardingCompleted: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function buildExportApp(callerRole: string | null) {
  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: 's@e.com', claims: {} });
    c.set('userRow', FIXED_USER);
    c.set('tenantId', TENANT_ID);
    await next();
  };
  let idx = 0;
  dbMock.select.mockImplementation(() => {
    idx += 1;
    if (idx === 1) return chain(callerRole ? [{ id: 'm1', role: callerRole }] : []);
    return chain([TENANT_ROW]);
  });
  dbMock.execute.mockResolvedValue({ rows: [] });
  const app = new Hono();
  app.use('*', seed);
  app.route('/api/admin', adminRouter);
  return app;
}

describe('FHS-435: GET /api/admin/export', () => {
  it('403 when the caller is not a tenant member', async () => {
    const res = await buildExportApp(null).request('/api/admin/export');
    expect(res.status).toBe(403);
  });

  it('403 ADMIN_ONLY for a normal user (adult)', async () => {
    const res = await buildExportApp('adult').request('/api/admin/export');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe('ADMIN_ONLY');
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it('200 for an admin: sets a downloadable Content-Disposition header', async () => {
    const app = buildExportApp('admin');
    const res = await app.request('/api/admin/export');
    expect(res.status).toBe(200);
    const disposition = res.headers.get('Content-Disposition');
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('khans');
    expect(disposition).toContain('.json');
  });

  it('response body carries the family row + one data key per tenant-scoped table', async () => {
    const app = buildExportApp('admin');
    const res = await app.request('/api/admin/export');
    const body = (await res.json()) as {
      exportedAt: string;
      family: { name: string; slug: string };
      data: Record<string, unknown>;
    };
    expect(body.family).toEqual({
      ...TENANT_ROW,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    // Spot-check a few of the families of data the ticket calls out by name.
    expect(body.data).toHaveProperty('members');
    expect(body.data).toHaveProperty('tasks');
    expect(body.data).toHaveProperty('habits');
    expect(body.data).toHaveProperty('habitStickers');
    expect(body.data).toHaveProperty('rewards');
    expect(body.data).toHaveProperty('redemptionRequests');
    expect(body.data).toHaveProperty('learnProgress');
  });
});

function buildDeleteApp(callerRole: string | null, tenantName = 'The Khans') {
  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: 's@e.com', claims: {} });
    c.set('userRow', FIXED_USER);
    c.set('tenantId', TENANT_ID);
    await next();
  };
  let idx = 0;
  dbMock.select.mockImplementation(() => {
    idx += 1;
    if (idx === 1) return chain(callerRole ? [{ id: 'm1', role: callerRole }] : []);
    return chain([{ name: tenantName }]);
  });
  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  dbMock.delete.mockImplementation(() => ({ where: deleteWhere }));
  dbMock.transaction.mockImplementation(async (fn: (tx: typeof dbMock) => Promise<unknown>) =>
    fn(dbMock),
  );
  const app = new Hono();
  app.use('*', seed);
  app.route('/api/admin', adminRouter);
  return { app, deleteWhere };
}

const postDelete = (confirm: string): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ confirm }),
});

describe('FHS-435: POST /api/admin/delete-account', () => {
  it('403 when the caller is not a tenant member', async () => {
    const { app } = buildDeleteApp(null);
    const res = await app.request('/api/admin/delete-account', postDelete('The Khans'));
    expect(res.status).toBe(403);
  });

  it('403 ADMIN_ONLY for a normal user (adult): nothing is deleted', async () => {
    const { app, deleteWhere } = buildDeleteApp('adult');
    const res = await app.request('/api/admin/delete-account', postDelete('The Khans'));
    expect(res.status).toBe(403);
    expect(dbMock.transaction).not.toHaveBeenCalled();
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('400 CONFIRM_MISMATCH when the typed name does not match: nothing is deleted', async () => {
    const { app, deleteWhere } = buildDeleteApp('admin');
    const res = await app.request('/api/admin/delete-account', postDelete('Wrong Family Name'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe('CONFIRM_MISMATCH');
    expect(dbMock.transaction).not.toHaveBeenCalled();
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it('400 when confirm is missing from the body', async () => {
    const { app } = buildDeleteApp('admin');
    const res = await app.request('/api/admin/delete-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('200 + deletes the tenant inside a transaction when the typed name matches exactly', async () => {
    const { app, deleteWhere } = buildDeleteApp('admin');
    const res = await app.request('/api/admin/delete-account', postDelete('The Khans'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(dbMock.transaction).toHaveBeenCalledTimes(1);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });
});
