import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { habitsRouter } from '../../../../apps/api/src/routes/habits.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-268 — validation + tenant guards for /api/habits. The DB-dependent
// behaviour (logs, balance maths) is covered by the real-Postgres
// integration test (childworld.feature).

const dbMock = { select: vi.fn(), insert: vi.fn(), delete: vi.fn() };
vi.mock('../../../../apps/api/src/db/client.js', () => ({ getDb: () => dbMock }));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const MEMBER_ID = '44444444-4444-4444-8444-444444444444';
const HABIT_ID = '22222222-2222-4222-8222-222222222222';
const FIXED_USER: User = {
  id: USER_ID,
  email: 's@e.com',
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
  updatedAt: new Date('2026-05-01T00:00:00.000Z'),
};

// Queue of results for the `.select().from().where().limit()` member
// existence checks, consumed in order (callerIsMember, then memberInTenant).
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

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
  dbMock.delete.mockReset();
});

describe('FHS-268 — GET /api/habits guards', () => {
  it('400 when no tenant context', async () => {
    const res = await buildApp({ noTenant: true }).request(
      `/api/habits?memberId=${MEMBER_ID}&weekStart=2026-06-08`,
    );
    expect(res.status).toBe(400);
  });

  it('400 when memberId is missing', async () => {
    const res = await buildApp().request('/api/habits?weekStart=2026-06-08');
    expect(res.status).toBe(400);
  });

  it('400 when weekStart is malformed', async () => {
    const res = await buildApp().request(`/api/habits?memberId=${MEMBER_ID}&weekStart=last-monday`);
    expect(res.status).toBe(400);
  });

  it('403 when the caller is not a member of the tenant', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      `/api/habits?memberId=${MEMBER_ID}&weekStart=2026-06-08`,
    );
    expect(res.status).toBe(403);
  });

  it('404 when the target member is not in the tenant', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller' }], []] }).request(
      `/api/habits?memberId=${MEMBER_ID}&weekStart=2026-06-08`,
    );
    expect(res.status).toBe(404);
  });
});

describe('FHS-268 — PATCH /api/habits/:id/log guards', () => {
  function patch(id: string, body: unknown): RequestInit {
    return {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  it('400 for a malformed habit id', async () => {
    const res = await buildApp().request(
      '/api/habits/not-a-uuid/log',
      patch('x', { memberId: MEMBER_ID, date: '2026-06-08', done: true }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when the body is invalid', async () => {
    const res = await buildApp().request(
      `/api/habits/${HABIT_ID}/log`,
      patch(HABIT_ID, { memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(400);
  });

  it('403 when the caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      `/api/habits/${HABIT_ID}/log`,
      patch(HABIT_ID, { memberId: MEMBER_ID, date: '2026-06-08', done: true }),
    );
    expect(res.status).toBe(403);
  });
});
