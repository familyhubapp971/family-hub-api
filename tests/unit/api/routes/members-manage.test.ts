import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { membersRouter } from '../../../../apps/api/src/routes/members.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-276 — POST / PATCH / DELETE /api/members. Admin-only roster
// mutations with the last-admin guard.

const dbMock = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() };
vi.mock('../../../../apps/api/src/db/client.js', () => ({
  getDb: () => dbMock,
}));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const FIXED_USER: User = {
  id: USER_ID,
  email: 'sarah@example.com',
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
  updatedAt: new Date('2026-05-01T00:00:00.000Z'),
};

function chain(rows: unknown): unknown {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    limit: () => obj,
    set: () => obj,
    values: () => obj,
    returning: () => Promise.resolve(rows),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej),
  };
  return obj;
}

interface SeedOpts {
  callerRole?: string;
  target?: { id: string; role: string; userId?: string | null } | null;
  adminRows?: number; // how many admins countAdmins sees
}

function buildApp(opts: SeedOpts = {}) {
  let idx = 0;
  dbMock.select.mockImplementation(() => {
    idx += 1;
    if (idx === 1) {
      // caller lookup
      return chain([{ id: 'caller-member-id', role: opts.callerRole ?? 'admin' }]);
    }
    if (idx === 2) {
      // PATCH/DELETE: target lookup. POST has no second select.
      return chain(opts.target === null ? [] : [opts.target ?? { id: TARGET_ID, role: 'adult' }]);
    }
    // admin count
    return chain(Array.from({ length: opts.adminRows ?? 2 }, (_, i) => ({ id: `a${i}` })));
  });
  dbMock.insert.mockImplementation(() =>
    chain([{ id: TARGET_ID, displayName: 'Amina', role: 'child' }]),
  );
  dbMock.update.mockImplementation(() =>
    chain([{ id: TARGET_ID, displayName: 'Yusuf', role: 'admin' }]),
  );
  dbMock.delete.mockImplementation(() => chain([]));

  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: FIXED_USER.email, claims: {} });
    c.set('userRow', FIXED_USER);
    c.set('tenantId', TENANT_ID);
    await next();
  };
  const app = new Hono();
  app.use('*', seed);
  app.route('/api/members', membersRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
  dbMock.update.mockReset();
  dbMock.delete.mockReset();
});

describe('FHS-276 — members roster mutations', () => {
  it('POST adds a child (admin caller) → 201', async () => {
    const app = buildApp({});
    const res = await app.request('/api/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Amina', role: 'child', age: 6 }),
    });
    expect(res.status).toBe(201);
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });

  it('POST is admin-only → 403 for an adult caller', async () => {
    const app = buildApp({ callerRole: 'adult' });
    const res = await app.request('/api/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Amina' }),
    });
    expect(res.status).toBe(403);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('PATCH role by a non-admin (teen) → 403, no escalation (FHS-336)', async () => {
    // A teen/child can't change roles — including granting themselves admin.
    const app = buildApp({ callerRole: 'teen' });
    const res = await app.request(`/api/members/${TARGET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(res.status).toBe(403);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('PATCH promotes a signed-up parent to admin → 200', async () => {
    const app = buildApp({ target: { id: TARGET_ID, role: 'adult', userId: 'u-linked' } });
    const res = await app.request(`/api/members/${TARGET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(res.status).toBe(200);
    expect(dbMock.update).toHaveBeenCalledTimes(1);
  });

  it('PATCH refuses to promote a pending (unclaimed) seat → 400 (FHS-278)', async () => {
    const app = buildApp({ target: { id: TARGET_ID, role: 'adult', userId: null } });
    const res = await app.request(`/api/members/${TARGET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(res.status).toBe(400);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('PATCH rejects an admin toggle on a kid → 400', async () => {
    const app = buildApp({ target: { id: TARGET_ID, role: 'child' } });
    const res = await app.request(`/api/members/${TARGET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(res.status).toBe(400);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('PATCH refuses self-demotion even with other admins → 400', async () => {
    // Target IS the caller (same member id) and an admin.
    const app = buildApp({ target: { id: 'caller-member-id', role: 'admin' }, adminRows: 2 });
    const res = await app.request(
      '/api/members/caller-member-id'.replace(
        'caller-member-id',
        '33333333-3333-4333-8333-333333333333',
      ),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'adult' }),
      },
    );
    expect(res.status).toBe(400);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('PATCH refuses to demote the last admin → 400', async () => {
    const app = buildApp({ target: { id: TARGET_ID, role: 'admin' }, adminRows: 1 });
    const res = await app.request(`/api/members/${TARGET_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'adult' }),
    });
    expect(res.status).toBe(400);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('DELETE refuses to remove the last admin → 400', async () => {
    const app = buildApp({ target: { id: TARGET_ID, role: 'admin' }, adminRows: 1 });
    const res = await app.request(`/api/members/${TARGET_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(dbMock.delete).not.toHaveBeenCalled();
  });

  it('DELETE removes a non-admin member → 200', async () => {
    const app = buildApp({ target: { id: TARGET_ID, role: 'child' } });
    const res = await app.request(`/api/members/${TARGET_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(dbMock.delete).toHaveBeenCalledTimes(1);
  });
});
