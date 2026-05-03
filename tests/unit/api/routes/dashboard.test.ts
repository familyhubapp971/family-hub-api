import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dashboardRouter } from '../../../../apps/api/src/routes/dashboard.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-228 — GET /api/dashboard/today. Same mock shape as the FHS-108
// /api/members test: stub the db at the module boundary, seed user +
// tenant context via a tiny middleware. Four select() calls fire in
// the route — caller-membership / members / habits-count / rewards-
// count — and the mock returns each in order.

const dbMock = { select: vi.fn() };
vi.mock('../../../../apps/api/src/db/client.js', () => ({
  getDb: () => dbMock,
}));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const USER_EMAIL = 'sarah.khan@example.com';
const FIXED_USER: User = {
  id: USER_ID,
  email: USER_EMAIL,
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
  updatedAt: new Date('2026-05-01T00:00:00.000Z'),
};

interface SeedOpts {
  noTenant?: boolean;
  callerMissing?: boolean;
}

interface SeedData {
  members?: Array<Record<string, unknown>>;
  habitsCount?: number;
  rewardsCount?: number;
  tenantTimezone?: string | null;
}

function buildAppWithSeed(opts: SeedOpts = {}, data: SeedData = {}) {
  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: USER_EMAIL, claims: {} });
    c.set('userRow', FIXED_USER);
    c.set('tenantId', opts.noTenant ? undefined : TENANT_ID);
    await next();
  };

  let selectCallIdx = 0;
  dbMock.select.mockImplementation(() => {
    selectCallIdx += 1;
    // 1 — caller membership lookup
    if (selectCallIdx === 1) {
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(opts.callerMissing ? [] : [{ id: 'caller-member-id' }]),
          }),
        }),
      };
    }
    // 2 — members list
    if (selectCallIdx === 2) {
      return {
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve(data.members ?? []),
          }),
        }),
      };
    }
    // 3 — habits count
    if (selectCallIdx === 3) {
      return {
        from: () => ({
          where: () => Promise.resolve([{ n: data.habitsCount ?? 0 }]),
        }),
      };
    }
    // 4 — rewards count
    if (selectCallIdx === 4) {
      return {
        from: () => ({
          where: () => Promise.resolve([{ n: data.rewardsCount ?? 0 }]),
        }),
      };
    }
    // 5 — tenant timezone lookup
    return {
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ timezone: data.tenantTimezone ?? 'UTC' }]),
        }),
      }),
    };
  });

  const app = new Hono();
  app.use('*', seed);
  app.route('/api/dashboard', dashboardRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
});

describe('FHS-228 — GET /api/dashboard/today', () => {
  it('returns 400 when no tenant is on the request', async () => {
    const app = buildAppWithSeed({ noTenant: true });
    const res = await app.request('/api/dashboard/today');
    expect(res.status).toBe(400);
  });

  it('returns 403 when the caller is not a member of the tenant', async () => {
    const app = buildAppWithSeed({ callerMissing: true });
    const res = await app.request('/api/dashboard/today');
    expect(res.status).toBe(403);
  });

  it('returns 200 with empty members + zero counts when tenant is empty', async () => {
    const app = buildAppWithSeed({}, { members: [], habitsCount: 0, rewardsCount: 0 });
    const res = await app.request('/api/dashboard/today');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      date: string;
      greetingName: string;
      members: unknown[];
      counts: { members: number; habits: number; rewards: number };
    };
    expect(body.members).toEqual([]);
    expect(body.counts).toEqual({ members: 0, habits: 0, rewards: 0 });
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // First-segment-of-email-localpart, capitalised.
    expect(body.greetingName).toBe('Sarah');
  });

  it('returns members + counts derived from the seed', async () => {
    const M1 = '22222222-2222-4222-8222-222222222222';
    const M2 = '33333333-3333-4333-8333-333333333333';
    const app = buildAppWithSeed(
      {},
      {
        members: [
          { id: M1, displayName: 'Sarah', role: 'admin', avatarEmoji: '👩' },
          { id: M2, displayName: 'Iman', role: 'child', avatarEmoji: null },
        ],
        habitsCount: 5,
        rewardsCount: 3,
      },
    );
    const res = await app.request('/api/dashboard/today');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: Array<{ id: string; displayName: string; role: string; avatarEmoji: string | null }>;
      counts: { members: number; habits: number; rewards: number };
    };
    expect(body.members).toHaveLength(2);
    expect(body.members[0]).toMatchObject({
      id: M1,
      displayName: 'Sarah',
      role: 'admin',
      avatarEmoji: '👩',
    });
    expect(body.members[1]).toMatchObject({
      id: M2,
      displayName: 'Iman',
      role: 'child',
      avatarEmoji: null,
    });
    expect(body.counts).toEqual({ members: 2, habits: 5, rewards: 3 });
  });

  it("anchors the date in the tenant's IANA timezone", async () => {
    // 22:00 UTC on 2026-05-03 → 02:00 next day in Asia/Dubai (+04).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T22:00:00.000Z'));
    try {
      const app = buildAppWithSeed(
        {},
        { members: [], habitsCount: 0, rewardsCount: 0, tenantTimezone: 'Asia/Dubai' },
      );
      const res = await app.request('/api/dashboard/today');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { date: string };
      expect(body.date).toBe('2026-05-04');
    } finally {
      vi.useRealTimers();
    }
  });
});
