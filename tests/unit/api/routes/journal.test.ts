import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { journalRouter } from '../../../../apps/api/src/routes/journal.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-270 — validation + tenant guards for /api/journal. DB-backed
// behaviour + member-scoping is covered by journal-learn.feature.

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
  app.route('/api/journal', journalRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
});

describe('FHS-270 — GET /api/journal guards', () => {
  it('400 when no tenant context', async () => {
    const res = await buildApp({ noTenant: true }).request(`/api/journal?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(400);
  });
  it('400 when memberId is missing', async () => {
    const res = await buildApp().request('/api/journal');
    expect(res.status).toBe(400);
  });
  it('403 when the caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      `/api/journal?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(403);
  });
  it('404 when the target member is not in the tenant', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'admin' }], []] }).request(
      `/api/journal?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(404);
  });

  it('403 when a non-parent caller targets another member', async () => {
    // caller is a teen member (not admin/adult, not the target).
    const res = await buildApp({
      memberChecks: [[{ id: 'caller', role: 'teen' }], [{ id: MEMBER_ID }]],
    }).request(`/api/journal?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(403);
  });
});

describe('FHS-270 — POST /api/journal guards', () => {
  function post(body: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }
  it('400 when body is empty after trim', async () => {
    const res = await buildApp().request(
      '/api/journal',
      post({ memberId: MEMBER_ID, body: '   ' }),
    );
    expect(res.status).toBe(400);
  });
  it('400 when memberId is missing', async () => {
    const res = await buildApp().request('/api/journal', post({ body: 'hi' }));
    expect(res.status).toBe(400);
  });
  it('403 when the caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      '/api/journal',
      post({ memberId: MEMBER_ID, body: 'hi' }),
    );
    expect(res.status).toBe(403);
  });
});
