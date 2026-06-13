import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rewardsRouter } from '../../../../apps/api/src/routes/rewards.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-268 — validation + tenant guards for /api/rewards. Balance maths +
// redemption ledger are covered by the integration test
// (childworld.feature, real Postgres).

const dbMock = { select: vi.fn(), insert: vi.fn() };
vi.mock('../../../../apps/api/src/db/client.js', () => ({ getDb: () => dbMock }));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const MEMBER_ID = '44444444-4444-4444-8444-444444444444';
const REWARD_ID = '33333333-3333-4333-8333-333333333333';
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
  app.route('/api/rewards', rewardsRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
});

describe('FHS-268 — GET /api/rewards guards', () => {
  it('400 when no tenant context', async () => {
    const res = await buildApp({ noTenant: true }).request(`/api/rewards?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(400);
  });

  it('400 when memberId is missing', async () => {
    const res = await buildApp().request('/api/rewards');
    expect(res.status).toBe(400);
  });

  it('403 when the caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      `/api/rewards?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(403);
  });

  it('404 when the target member is not in the tenant', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller' }], []] }).request(
      `/api/rewards?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(404);
  });
});

describe('FHS-268 — POST /api/rewards/:id/redeem guards', () => {
  function post(body: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  it('400 for a malformed reward id', async () => {
    const res = await buildApp().request(
      '/api/rewards/not-a-uuid/redeem',
      post({ memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when memberId is missing from the body', async () => {
    const res = await buildApp().request(`/api/rewards/${REWARD_ID}/redeem`, post({}));
    expect(res.status).toBe(400);
  });

  it('403 when the caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      `/api/rewards/${REWARD_ID}/redeem`,
      post({ memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(403);
  });
});
