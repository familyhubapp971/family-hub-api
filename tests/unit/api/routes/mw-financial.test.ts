import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mwFinancialRouter,
  createInvestmentRequestSchema,
} from '../../../../apps/api/src/routes/mw-financial.js';
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
  // FHS-512 — guard() now also resolves the member's effective rate via an
  // innerJoin query; the chain below supports both `.from().where().limit()`
  // and `.from().innerJoin().where().limit()` so every select() (however
  // many hops) draws its result from the same `queue`, in call order.
  dbMock.select.mockImplementation(() => {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(queue.shift() ?? []),
    };
    return chain;
  });
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
  // FHS-534 — coefficient is a locked preset; a non-preset value is a 400 at
  // the schema boundary, before any DB work.
  it('400 when coefficient is not one of the 1/2/3/5 presets', async () => {
    const res = await buildApp().request(
      '/api/mw/financial/investments',
      json({
        memberId: MEMBER_ID,
        habitId: '22222222-2222-4222-8222-222222222222',
        stickerCount: 10,
        coefficient: 4,
      }),
    );
    expect(res.status).toBe(400);
  });
});

// FHS-534 — the coefficient preset contract, asserted directly on the schema.
describe('FHS-534 — createInvestmentRequestSchema coefficient', () => {
  const base = {
    memberId: MEMBER_ID,
    habitId: '22222222-2222-4222-8222-222222222222',
    stickerCount: 10,
  };
  it('accepts each of the 1/2/3/5 presets', () => {
    for (const c of [1, 2, 3, 5]) {
      expect(createInvestmentRequestSchema.safeParse({ ...base, coefficient: c }).success).toBe(
        true,
      );
    }
  });
  it('rejects any non-preset value (0, 4, negative, fractional, string)', () => {
    for (const c of [0, 4, -1, 2.5, '5']) {
      expect(createInvestmentRequestSchema.safeParse({ ...base, coefficient: c }).success).toBe(
        false,
      );
    }
  });
  it('defaults the coefficient to 5 when omitted (legacy rate)', () => {
    const parsed = createInvestmentRequestSchema.parse(base);
    expect(parsed.coefficient).toBe(5);
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
    // Queue: [callerRow], [memberExistsRow], [rate row], habit lookup returns [] (not found for this member)
    const res = await buildApp({
      memberChecks: [
        [{ id: 'admin-member-id', role: 'admin' }], // loadCaller
        [{ id: MEMBER_ID }], // memberInTenant
        [{ memberRate: null, tenantRate: 50 }], // rate resolver (FHS-512)
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

// FHS-378 — POST /investments/:id/settings (deductible toggle).
//
// Guard + validation paths use the lightweight select-only mock; the 404 / 409
// / success transaction paths use a transaction-aware mock that drives the
// select/update chain inside db.transaction(...). The full recalc + roll-over
// preservation is proven against real Postgres in the integration tier.
describe('FHS-378 — POST /investments/:id/settings guards + transaction paths', () => {
  const INV_ID = '33333333-3333-4333-8333-333333333333';

  it('400 on invalid body (missing deductible)', async () => {
    const res = await buildApp().request(
      `/api/mw/financial/investments/${INV_ID}/settings`,
      json({ memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(400);
  });

  it('403 when the caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      `/api/mw/financial/investments/${INV_ID}/settings`,
      json({ memberId: MEMBER_ID, deductible: false }),
    );
    expect(res.status).toBe(403);
  });

  // A transaction-aware db mock: guard runs on the pool `select`, then the
  // handler body runs inside `transaction(cb)` against a tx whose `select`
  // pulls from `txSelects` (in order) and whose `update` returns `updatedRow`.
  function buildTxApp(opts: { txSelects: unknown[][]; updatedRow?: unknown }) {
    const guardQueue: unknown[][] = [
      [{ id: 'caller', role: 'admin' }], // loadCaller
      [{ id: MEMBER_ID }], // memberInTenant
      [{ memberRate: null, tenantRate: 50 }], // rate resolver (FHS-512)
    ];
    const txQueue = [...opts.txSelects];
    // `where()` returns a thenable array (for count selects that await it
    // directly) that ALSO exposes `.limit()` (for selects that paginate). Each
    // call consumes the next queued result so both shapes draw from txQueue.
    function whereResult() {
      const rows = txQueue.shift() ?? [];
      return {
        then: (resolve: (v: unknown[]) => unknown) => resolve(rows),
        limit: () => Promise.resolve(rows),
      };
    }
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn(() => ({ from: () => ({ where: () => whereResult() }) })),
      update: vi.fn(() => ({
        set: () => ({
          where: () => ({ returning: () => Promise.resolve([opts.updatedRow]) }),
        }),
      })),
    };
    const seed: MiddlewareHandler = async (c, next) => {
      c.set('user', { id: USER_ID, email: 's@e.com', claims: {} });
      c.set('userRow', FIXED_USER);
      c.set('tenantId', TENANT_ID);
      await next();
    };
    dbMock.select.mockImplementation(() => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(guardQueue.shift() ?? []),
      };
      return chain;
    });

    (dbMock as any).transaction = vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx));
    const app = new Hono();
    app.use('*', seed);
    app.route('/api/mw/financial', mwFinancialRouter);
    return app;
  }

  it('404 when the investment does not exist in this tenant', async () => {
    // txSelects[0] = anyRows lookup → empty (not found).
    const res = await buildTxApp({ txSelects: [[]] }).request(
      `/api/mw/financial/investments/${INV_ID}/settings`,
      json({ memberId: MEMBER_ID, deductible: false }),
    );
    expect(res.status).toBe(404);
  });

  it('409 when the investment exists but is not active', async () => {
    // txSelects[0] = anyRows lookup → exists but isActive=false.
    const res = await buildTxApp({ txSelects: [[{ isActive: false }]] }).request(
      `/api/mw/financial/investments/${INV_ID}/settings`,
      json({ memberId: MEMBER_ID, deductible: false }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe('INVESTMENT_NOT_ACTIVE');
  });

  it('200 updates the flag and recalculates value (no missed-day penalty when false)', async () => {
    const invRow = {
      id: INV_ID,
      tenantId: TENANT_ID,
      memberId: MEMBER_ID,
      habitId: '22222222-2222-4222-8222-222222222222',
      weekId: '55555555-5555-4555-8555-555555555555',
      investedStickers: 10,
      originalInvestedStickers: 10,
      currentValue: '5',
      daysCompleted: 0,
      daysMissed: 0,
      isActive: true,
      isResolved: false,
      deductible: true,
    };
    const updatedRow = { ...invRow, deductible: false, currentValue: '5.00' };
    const res = await buildTxApp({
      txSelects: [
        [{ isActive: true }], // anyRows
        [invRow], // full row
        [{ isFinalized: false, startDate: '2026-06-15' }], // week
        [{ n: 0 }], // completed count
        [{ n: 0 }], // past count
      ],
      updatedRow,
    }).request(
      `/api/mw/financial/investments/${INV_ID}/settings`,
      json({ memberId: MEMBER_ID, deductible: false }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deductible: boolean };
    expect(body.deductible).toBe(false);
  });
});

// FHS-335 — manually overwriting a balance (Admin Panel) is admin-only.
// A normal user (adult) passes membership/canManage but is then rejected.
describe('FHS-335 — balance admin-set is admin-only', () => {
  it('PUT /savings/admin-set as a normal user → 403 ADMIN_ONLY', async () => {
    const res = await buildApp({
      memberChecks: [
        [{ id: 'caller', role: 'adult' }], // loadCaller
        [{ id: MEMBER_ID }], // memberInTenant
        [{ memberRate: null, tenantRate: 50 }], // rate resolver (FHS-512)
        [{ role: 'adult' }], // explicit admin-role re-check in the handler
      ],
    }).request('/api/mw/financial/savings/admin-set', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: MEMBER_ID, savedStickers: 10, savedCash: 5 }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe('ADMIN_ONLY');
  });
});
