import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mwWeeksRouter } from '../../../../apps/api/src/routes/mw-weeks.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-293 — unit guard tests for /api/mw/weeks.
// DB-backed behaviour + sticker math is covered by integration tests.

// ─── DB mock — every select returns the next item in a queue ─────────────────

const dbMock = { select: vi.fn(), insert: vi.fn() };
vi.mock('../../../../apps/api/src/db/client.js', () => ({ getDb: () => dbMock }));

// Stub out getOrCreateCurrentWeek so routes that call it don't need real DB,
// but keep the real shared loaders (loadWeekActions/Stats/loadWeeksForMember,
// FHS-374) — they were extracted verbatim from these routes and consume the
// same DB query queue, so the queue-based dbMock still drives them.
vi.mock('../../../../apps/api/src/lib/myworld.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../apps/api/src/lib/myworld.js')>();
  return {
    ...actual,
    getOrCreateCurrentWeek: vi.fn().mockResolvedValue({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tenantId: '11111111-1111-4111-8111-111111111111',
      memberId: '44444444-4444-4444-8444-444444444444',
      weekNumber: 24,
      year: 2026,
      startDate: '2026-06-08',
      isFinalized: false,
      carriedOverStickers: 0,
      carriedOverCash: '0',
      retrievedStickers: 0,
      retrievedCash: '0',
      closureSnapshot: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  };
});

// ─── Constants ────────────────────────────────────────────────────────────────

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const MEMBER_ID = '44444444-4444-4444-8444-444444444444';
const WEEK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const FIXED_USER: User = {
  id: USER_ID,
  email: 's@e.com',
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: new Date('2026-06-01T00:00:00.000Z'),
};

// ─── Test app builder ─────────────────────────────────────────────────────────

/**
 * memberChecks is an ordered queue of arrays. Each `.select()…limit()` call
 * in the route handler pops the next array from the front — so the order must
 * match the route's query order:
 *   1. loadCaller  → members (find caller by userId)
 *   2. memberInTenant → members (find target by memberId)
 *   (stats route also queries mwWeeks + up to 3x habitStickers selects)
 */
function buildApp(opts: { noTenant?: boolean; memberChecks?: unknown[][] } = {}) {
  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: 's@e.com', claims: {} });
    c.set('userRow', FIXED_USER);
    c.set('tenantId', opts.noTenant ? undefined : TENANT_ID);
    await next();
  };
  const queue = [...(opts.memberChecks ?? [])];
  dbMock.select.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(queue.shift() ?? []),
        // orderBy variant (used by the list route)
        orderBy: () => Promise.resolve(queue.shift() ?? []),
      }),
      orderBy: () => Promise.resolve(queue.shift() ?? []),
    }),
  }));

  const app = new Hono();
  app.use('*', seed);
  app.route('/api/mw/weeks', mwWeeksRouter);
  return app;
}

// ─── Reset mocks before each test ────────────────────────────────────────────

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
});

// ─── GET / ────────────────────────────────────────────────────────────────────

describe('GET /api/mw/weeks', () => {
  it('400 when no tenant context', async () => {
    const res = await buildApp({ noTenant: true }).request(`/api/mw/weeks?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe('TENANT_REQUIRED');
  });

  it('400 when memberId is missing', async () => {
    const res = await buildApp().request('/api/mw/weeks');
    expect(res.status).toBe(400);
  });

  it('400 when memberId is not a UUID', async () => {
    const res = await buildApp().request('/api/mw/weeks?memberId=not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('403 when caller is not a member of this tenant', async () => {
    // loadCaller returns empty → caller not found
    const res = await buildApp({ memberChecks: [[]] }).request(
      `/api/mw/weeks?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.detail).toMatch(/caller is not a member/);
  });

  it('404 when target member is not in this tenant', async () => {
    // loadCaller returns caller; memberInTenant returns empty
    const res = await buildApp({
      memberChecks: [[{ id: 'caller-id', role: 'admin' }], []],
    }).request(`/api/mw/weeks?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.detail).toMatch(/member not found/);
  });

  it('403 when a non-parent caller targets another member', async () => {
    // caller is a teen (not admin/adult) and not the target member
    const res = await buildApp({
      memberChecks: [[{ id: 'other-caller', role: 'teen' }], [{ id: MEMBER_ID }]],
    }).request(`/api/mw/weeks?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.detail).toMatch(/not allowed/);
  });
});

// ─── GET /current ─────────────────────────────────────────────────────────────

describe('GET /api/mw/weeks/current', () => {
  it('400 when no tenant context', async () => {
    const res = await buildApp({ noTenant: true }).request(
      `/api/mw/weeks/current?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe('TENANT_REQUIRED');
  });

  it('400 when memberId is missing', async () => {
    const res = await buildApp().request('/api/mw/weeks/current');
    expect(res.status).toBe(400);
  });

  it('403 when caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      `/api/mw/weeks/current?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(403);
  });

  it('404 when target member not in tenant', async () => {
    const res = await buildApp({
      memberChecks: [[{ id: 'caller-id', role: 'admin' }], []],
    }).request(`/api/mw/weeks/current?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(404);
  });
});

// ─── GET /:id/stats ───────────────────────────────────────────────────────────

describe('GET /api/mw/weeks/:id/stats', () => {
  it('400 when no tenant context', async () => {
    const res = await buildApp({ noTenant: true }).request(
      `/api/mw/weeks/${WEEK_ID}/stats?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe('TENANT_REQUIRED');
  });

  it('400 when memberId is missing', async () => {
    const res = await buildApp().request(`/api/mw/weeks/${WEEK_ID}/stats`);
    expect(res.status).toBe(400);
  });

  it('403 when caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      `/api/mw/weeks/${WEEK_ID}/stats?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(403);
  });

  it('404 when target member not in tenant', async () => {
    const res = await buildApp({
      memberChecks: [[{ id: 'caller-id', role: 'admin' }], []],
    }).request(`/api/mw/weeks/${WEEK_ID}/stats?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(404);
  });
});

// ─── GET /:id/actions ──────────────────────────────────────────────────────────

describe('GET /api/mw/weeks/:id/actions', () => {
  it('coerces numeric cashAmount to a number so the client can format it (FHS-314)', async () => {
    const res = await buildApp({
      // loadCaller, memberInTenant, weekRows-belongs-check, actions
      memberChecks: [
        [{ id: 'caller-id', role: 'admin' }],
        [{ id: MEMBER_ID }],
        [{ id: WEEK_ID }],
        [
          {
            id: 'act-1',
            actionType: 'invest_continue',
            stickersUsed: 3,
            cashAmount: '5.00', // Drizzle numeric → string off the DB
            rewardName: null,
            habitId: null,
            habitName: 'Reading',
            createdAt: new Date('2026-06-10T00:00:00.000Z'),
          },
          {
            id: 'act-2',
            actionType: 'save',
            stickersUsed: 2,
            cashAmount: null,
            rewardName: null,
            habitId: null,
            habitName: null,
            createdAt: new Date('2026-06-10T00:00:00.000Z'),
          },
        ],
      ],
    }).request(`/api/mw/weeks/${WEEK_ID}/actions?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      actions: Array<{ cashAmount: number | null }>;
    };
    expect(typeof body.actions[0]!.cashAmount).toBe('number');
    expect(body.actions[0]!.cashAmount).toBe(5);
    // null cash amounts stay null (not coerced to 0).
    expect(body.actions[1]!.cashAmount).toBeNull();
  });
});

// FHS-335 — closing, reopening, and repairing a week are admin-only. A normal
// user (adult) passes membership but is rejected before any economy change.
describe('FHS-335 — week lifecycle is admin-only', () => {
  function post(path: string) {
    return buildApp({
      memberChecks: [[{ id: 'caller-id', role: 'adult' }], [{ id: MEMBER_ID }]],
    }).request(`/api/mw/weeks/${WEEK_ID}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: MEMBER_ID }),
    });
  }

  it('finalize as a normal user → 403 ADMIN_ONLY', async () => {
    const res = await post('finalize');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe('ADMIN_ONLY');
  });
  it('reopen as a normal user → 403 ADMIN_ONLY', async () => {
    const res = await post('reopen');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe('ADMIN_ONLY');
  });
  it('repair as a normal user → 403 ADMIN_ONLY', async () => {
    const res = await post('repair');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe('ADMIN_ONLY');
  });
});
