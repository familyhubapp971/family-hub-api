import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { habitsRouter } from '../../../../apps/api/src/routes/habits.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-292 — auth/tenant/role guards for /api/habits (sticker model). The
// DB-backed behaviour (sticker placement, balance, week creation) is
// covered by the myworld integration tests.

const dbMock = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() };
vi.mock('../../../../apps/api/src/db/client.js', () => ({ getDb: () => dbMock }));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const MEMBER_ID = '44444444-4444-4444-8444-444444444444';
const HABIT_ID = '55555555-5555-4555-8555-555555555555';
const WEEK_ID = '66666666-6666-4666-8666-666666666666';
const FIXED_USER: User = {
  id: USER_ID,
  email: 's@e.com',
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
  updatedAt: new Date('2026-05-01T00:00:00.000Z'),
};

function buildApp(opts: { noTenant?: boolean; memberChecks?: unknown[][] } = {}) {
  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: 's@e.com', claims: {} });
    c.set('userRow', FIXED_USER);
    c.set('tenantId', opts.noTenant ? undefined : TENANT_ID);
    await next();
  };
  const queue = [...(opts.memberChecks ?? [])];
  dbMock.select.mockImplementation(() => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(queue.shift() ?? []) }) }),
  }));
  const app = new Hono();
  app.use('*', seed);
  app.route('/api/habits', habitsRouter);
  return app;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
  dbMock.update.mockReset();
  dbMock.delete.mockReset();
});

describe('FHS-292 — GET /api/habits guards', () => {
  it('400 when no tenant context', async () => {
    const res = await buildApp({ noTenant: true }).request(`/api/habits?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(400);
  });
  it('400 when memberId is missing', async () => {
    const res = await buildApp().request('/api/habits');
    expect(res.status).toBe(400);
  });
  it('403 when the caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(`/api/habits?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(403);
  });
  it('404 when the target member is not in the tenant', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'admin' }], []] }).request(
      `/api/habits?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(404);
  });
  it('403 when a non-parent caller targets another member', async () => {
    const res = await buildApp({
      memberChecks: [[{ id: 'caller', role: 'teen' }], [{ id: MEMBER_ID }]],
    }).request(`/api/habits?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(403);
  });
});

describe('FHS-292 — POST /api/habits guards', () => {
  it('400 on an empty name', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'admin' }]] }).request(
      '/api/habits',
      json('POST', { memberId: MEMBER_ID, name: '   ' }),
    );
    expect(res.status).toBe(400);
  });
  it('403 when the caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      '/api/habits',
      json('POST', { memberId: MEMBER_ID, name: 'Read' }),
    );
    expect(res.status).toBe(403);
  });
  it('404 when the target member is absent', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'admin' }], []] }).request(
      '/api/habits',
      json('POST', { memberId: MEMBER_ID, name: 'Read' }),
    );
    expect(res.status).toBe(404);
  });
});

describe('FHS-292 — sticker placement guards', () => {
  it('400 on an out-of-range day', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'admin' }]] }).request(
      `/api/habits/${HABIT_ID}/stickers`,
      json('POST', { memberId: MEMBER_ID, weekId: WEEK_ID, day: 9, sticker: 'gold-star' }),
    );
    expect(res.status).toBe(400);
  });
  it('400 on an unknown sticker type', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'admin' }]] }).request(
      `/api/habits/${HABIT_ID}/stickers`,
      json('POST', { memberId: MEMBER_ID, weekId: WEEK_ID, day: 0, sticker: 'diamond' }),
    );
    expect(res.status).toBe(400);
  });
  it('403 when a non-parent caller targets another member', async () => {
    const res = await buildApp({
      memberChecks: [[{ id: 'caller', role: 'teen' }], [{ id: MEMBER_ID }]],
    }).request(
      `/api/habits/${HABIT_ID}/stickers`,
      json('POST', { memberId: MEMBER_ID, weekId: WEEK_ID, day: 0, sticker: 'gold-star' }),
    );
    expect(res.status).toBe(403);
  });
});

describe('FHS-292 — DELETE /api/habits/:id guards', () => {
  it('400 on a non-UUID id', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'admin' }]] }).request(
      '/api/habits/not-a-uuid',
      { method: 'DELETE' },
    );
    expect(res.status).toBe(400);
  });
  it('403 when the caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(`/api/habits/${HABIT_ID}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(403);
  });
});
