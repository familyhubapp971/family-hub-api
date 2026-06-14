import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mwFinancialRouter } from '../../../../apps/api/src/routes/mw-financial.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-295 — validation + tenant/member guards for /api/mw/financial.
// Save/cashout accounting is covered by the integration tier.

const dbMock = { select: vi.fn() };
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
  app.route('/api/mw/financial', mwFinancialRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
});

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('FHS-295 — GET /api/mw/financial/savings guards', () => {
  it('400 when memberId is missing', async () => {
    const res = await buildApp().request('/api/mw/financial/savings');
    expect(res.status).toBe(400);
  });
  it('400 when no tenant context', async () => {
    const res = await buildApp({ noTenant: true }).request(
      `/api/mw/financial/savings?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(400);
  });
  it('403 when the caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      `/api/mw/financial/savings?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(403);
  });
  it('404 when the target member is not in the tenant', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'admin' }], []] }).request(
      `/api/mw/financial/savings?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(404);
  });
  it('403 when a non-parent caller targets another member', async () => {
    const res = await buildApp({
      memberChecks: [[{ id: 'caller', role: 'teen' }], [{ id: MEMBER_ID }]],
    }).request(`/api/mw/financial/savings?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(403);
  });
});

describe('FHS-295 — POST save / cashout guards', () => {
  it('save 400 on invalid body (bad type)', async () => {
    const res = await buildApp().request(
      '/api/mw/financial/savings',
      json({ memberId: MEMBER_ID, type: 'x', amount: 5 }),
    );
    expect(res.status).toBe(400);
  });
  it('save 400 on non-positive amount', async () => {
    const res = await buildApp().request(
      '/api/mw/financial/savings',
      json({ memberId: MEMBER_ID, type: 'stickers', amount: 0 }),
    );
    expect(res.status).toBe(400);
  });
  it('save 403 when the caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      '/api/mw/financial/savings',
      json({ memberId: MEMBER_ID, type: 'stickers', amount: 5 }),
    );
    expect(res.status).toBe(403);
  });
  it('cashout 400 on missing amount', async () => {
    const res = await buildApp().request(
      '/api/mw/financial/savings/cashout',
      json({ memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(400);
  });
  it('cashout 403 when the caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      '/api/mw/financial/savings/cashout',
      json({ memberId: MEMBER_ID, amount: 5 }),
    );
    expect(res.status).toBe(403);
  });
});
