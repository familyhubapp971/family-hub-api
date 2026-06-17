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

// FHS-296 — investment route guards
describe('FHS-296 — GET /api/mw/financial/investments guards', () => {
  it('400 when memberId is missing', async () => {
    const res = await buildApp().request('/api/mw/financial/investments');
    expect(res.status).toBe(400);
  });
  it('400 when no tenant context', async () => {
    const res = await buildApp({ noTenant: true }).request(
      `/api/mw/financial/investments?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(400);
  });
  it('403 when the caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      `/api/mw/financial/investments?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(403);
  });
});

describe('FHS-296 — POST /api/mw/financial/investments guards', () => {
  it('400 when stickerCount is below 10', async () => {
    const res = await buildApp().request(
      '/api/mw/financial/investments',
      json({
        memberId: MEMBER_ID,
        habitId: '22222222-2222-4222-8222-222222222222',
        stickerCount: 5,
      }),
    );
    expect(res.status).toBe(400);
  });
  it('400 when stickerCount is missing', async () => {
    const res = await buildApp().request(
      '/api/mw/financial/investments',
      json({ memberId: MEMBER_ID, habitId: '22222222-2222-4222-8222-222222222222' }),
    );
    expect(res.status).toBe(400);
  });
  it('403 when the caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      '/api/mw/financial/investments',
      json({
        memberId: MEMBER_ID,
        habitId: '22222222-2222-4222-8222-222222222222',
        stickerCount: 10,
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe('FHS-296 — POST /api/mw/financial/investments/:id/withdraw guards', () => {
  it('403 when the caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      '/api/mw/financial/investments/33333333-3333-4333-8333-333333333333/withdraw',
      json({ memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(403);
  });
});

// FIX 1 — invest in another child's habit returns 404
describe('FHS-296 — FIX 1: habit must belong to the requesting member', () => {
  it('404 when the habit exists in the tenant but belongs to a different child', async () => {
    // Queue: [callerRow], [memberExistsRow], habit lookup returns [] (not found for this member)
    const res = await buildApp({
      memberChecks: [
        [{ id: 'admin-member-id', role: 'admin' }], // loadCaller
        [{ id: MEMBER_ID }], // memberInTenant
        [], // habit lookup scoped to memberId → empty
      ],
    }).request(
      '/api/mw/financial/investments',
      json({
        memberId: MEMBER_ID,
        habitId: '22222222-2222-4222-8222-222222222222',
        stickerCount: 10,
      }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.detail).toMatch(/member/);
  });
});

// FHS-335 — manually overwriting a balance (Admin Panel) is admin-only.
// A normal user (adult) passes membership/canManage but is then rejected.
describe('FHS-335 — balance admin-set is admin-only', () => {
  it('PUT /savings/admin-set as a normal user → 403 ADMIN_ONLY', async () => {
    const res = await buildApp({
      memberChecks: [[{ id: 'caller', role: 'adult' }], [{ id: MEMBER_ID }], [{ role: 'adult' }]],
    }).request('/api/mw/financial/savings/admin-set', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: MEMBER_ID, savedStickers: 10, savedCash: 5 }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe('ADMIN_ONLY');
  });
});
