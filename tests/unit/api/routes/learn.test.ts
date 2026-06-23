import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { learnRouter } from '../../../../apps/api/src/routes/learn.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-270 — validation + tenant guards for /api/learn. DB-backed upsert +
// defaulting is covered by journal-learn.feature.

const dbMock = { select: vi.fn(), insert: vi.fn() };
vi.mock('../../../../apps/api/src/db/client.js', () => ({ getDb: () => dbMock }));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const MEMBER_ID = '44444444-4444-4444-8444-444444444444';
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
  app.route('/api/learn', learnRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
});

describe('FHS-270 — GET /api/learn guards', () => {
  it('400 when no tenant context', async () => {
    const res = await buildApp({ noTenant: true }).request(`/api/learn?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(400);
  });
  it('400 when memberId is missing', async () => {
    const res = await buildApp().request('/api/learn');
    expect(res.status).toBe(400);
  });
  it('403 when the caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(`/api/learn?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(403);
  });

  it('403 when a non-parent caller targets another member', async () => {
    const res = await buildApp({
      memberChecks: [[{ id: 'caller', role: 'teen' }], [{ id: MEMBER_ID }]],
    }).request(`/api/learn?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(403);
  });
});

describe('FHS-371 — GET /api/learn/:subject/questions subtopic', () => {
  it('400 for an invalid subtopic value', async () => {
    const res = await buildApp().request(
      `/api/learn/Logic/questions?memberId=${MEMBER_ID}&subtopic=bogus`,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid request');
  });
});

describe('FHS-270 — PATCH /api/learn/:subject guards', () => {
  function patch(body: unknown): RequestInit {
    return {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }
  it('400 for a subject not in the catalogue', async () => {
    const res = await buildApp().request(
      '/api/learn/Quidditch',
      patch({ memberId: MEMBER_ID, progress: 50 }),
    );
    expect(res.status).toBe(400);
  });
  it('400 for out-of-range progress', async () => {
    const res = await buildApp().request(
      '/api/learn/Maths',
      patch({ memberId: MEMBER_ID, progress: 250 }),
    );
    expect(res.status).toBe(400);
  });
  it('403 when the caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      '/api/learn/Maths',
      patch({ memberId: MEMBER_ID, progress: 50 }),
    );
    expect(res.status).toBe(403);
  });
});
