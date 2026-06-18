import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adminRouter } from '../../../../apps/api/src/routes/admin.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-343 — the Admin Panel settings endpoint is admin-only. GET is readable by
// any member; PUT (mutating a setting) requires the admin role.

const dbMock = { select: vi.fn(), insert: vi.fn() };
vi.mock('../../../../apps/api/src/db/client.js', () => ({ getDb: () => dbMock }));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const FIXED_USER: User = {
  id: USER_ID,
  email: 's@e.com',
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: new Date('2026-06-01T00:00:00.000Z'),
};

function buildApp(callerRole: string | null) {
  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: 's@e.com', claims: {} });
    c.set('userRow', FIXED_USER);
    c.set('tenantId', TENANT_ID);
    await next();
  };
  // loadCaller → one select().from().where().limit()
  dbMock.select.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(callerRole ? [{ id: 'm1', role: callerRole }] : []),
      }),
    }),
  }));
  dbMock.insert.mockImplementation(() => ({
    values: () => ({
      onConflictDoUpdate: () => ({ returning: () => Promise.resolve([{ key: 'k', value: 'v' }]) }),
    }),
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
});

describe('FHS-343 — PUT /api/admin/settings/:key is admin-only', () => {
  it('403 when the caller is not a member', async () => {
    const res = await buildApp(null).request('/api/admin/settings/theme', put('dark'));
    expect(res.status).toBe(403);
  });
  it('403 ADMIN_ONLY for a normal user (adult)', async () => {
    const res = await buildApp('adult').request('/api/admin/settings/theme', put('dark'));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe('ADMIN_ONLY');
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
  it('200 for an admin', async () => {
    const res = await buildApp('admin').request('/api/admin/settings/theme', put('dark'));
    expect(res.status).toBe(200);
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });
});
