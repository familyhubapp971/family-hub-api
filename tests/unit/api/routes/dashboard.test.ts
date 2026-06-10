import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dashboardRouter } from '../../../../apps/api/src/routes/dashboard.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-228 / FHS-262 — GET /api/dashboard/today. The route fires a fixed
// sequence of select() calls; we stub the db at the module boundary and
// return seeded rows for each call in order. The mock is chain-agnostic
// (from/where/orderBy/leftJoin/limit all return the same thenable) so it
// tolerates each query's differing builder shape. Derivation logic is
// covered in dashboard-helpers.test.ts; this file covers wiring + shape.

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
  habitIds?: string[];
  rewardsCount?: number;
  tenantTimezone?: string | null;
  weeks?: Array<{ id: string; startDate: string; endDate: string }>;
  actions?: Array<{ weekId: string; memberId: string; habitId: string; completedCount: number }>;
  tasks?: Array<{ memberId: string | null; doneAt: Date | null }>;
  savings?: Array<{ id: string; name: string; targetAmount: string | null }>;
  tx?: Array<{ savingsId: string; amount: string; type: 'deposit' | 'withdrawal' }>;
  activity?: Array<{ id: string; action: string; createdAt: Date; actor: string | null }>;
  mealsCount?: number;
}

// A thenable that resolves to `rows` no matter where the builder chain
// stops (await db.select()...where()/orderBy()/limit()).
function chain(rows: unknown): unknown {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    orderBy: () => obj,
    leftJoin: () => obj,
    limit: () => obj,
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return obj;
}

function buildAppWithSeed(opts: SeedOpts = {}, data: SeedData = {}) {
  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: USER_EMAIL, claims: {} });
    c.set('userRow', FIXED_USER);
    c.set('tenantId', opts.noTenant ? undefined : TENANT_ID);
    await next();
  };

  let idx = 0;
  dbMock.select.mockImplementation(() => {
    idx += 1;
    switch (idx) {
      case 1: // caller membership
        return chain(opts.callerMissing ? [] : [{ id: 'caller-member-id' }]);
      case 2: // members roster
        return chain(data.members ?? []);
      case 3: // active habit ids
        return chain((data.habitIds ?? []).map((id) => ({ id })));
      case 4: // rewards count
        return chain([{ n: data.rewardsCount ?? 0 }]);
      case 5: // tenant timezone
        return chain([{ timezone: data.tenantTimezone ?? 'UTC' }]);
      case 6: // weeks
        return chain(data.weeks ?? []);
      case 7: // week actions
        return chain(data.actions ?? []);
      case 8: // tasks
        return chain(data.tasks ?? []);
      case 9: // savings
        return chain(data.savings ?? []);
      case 10: // savings transactions
        return chain(data.tx ?? []);
      case 11: // activity feed
        return chain(data.activity ?? []);
      default: // 12 — meals count
        return chain([{ n: data.mealsCount ?? 0 }]);
    }
  });

  const app = new Hono();
  app.use('*', seed);
  app.route('/api/dashboard', dashboardRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
});

describe('FHS-228 / FHS-262 — GET /api/dashboard/today', () => {
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

  it('returns sensible zeros / empty arrays for a brand-new family', async () => {
    const app = buildAppWithSeed({}, {});
    const res = await app.request('/api/dashboard/today');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: unknown[];
      counts: Record<string, number>;
      goals: unknown[];
      recentActivity: unknown[];
      date: string;
      greetingName: string;
    };
    expect(body.members).toEqual([]);
    expect(body.counts).toEqual({
      members: 0,
      habits: 0,
      rewards: 0,
      tasksDoneToday: 0,
      mealsPlanned: 0,
    });
    expect(body.goals).toEqual([]);
    expect(body.recentActivity).toEqual([]);
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.greetingName).toBe('Sarah');
  });

  it('derives per-member stats, snapshot counts, goals and activity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T12:00:00.000Z')); // Wed
    try {
      const M1 = '22222222-2222-4222-8222-222222222222';
      const M2 = '33333333-3333-4333-8333-333333333333';
      const H1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
      const H2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
      const WK = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
      const G1 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
      const app = buildAppWithSeed(
        {},
        {
          members: [
            { id: M1, displayName: 'Sarah', role: 'admin', avatarEmoji: '👩' },
            { id: M2, displayName: 'Iman', role: 'child', avatarEmoji: null },
          ],
          habitIds: [H1, H2],
          rewardsCount: 3,
          weeks: [{ id: WK, startDate: '2026-06-08', endDate: '2026-06-14' }],
          actions: [
            { weekId: WK, memberId: M1, habitId: H1, completedCount: 1 },
            { weekId: WK, memberId: M1, habitId: H2, completedCount: 2 },
            { weekId: WK, memberId: M2, habitId: H1, completedCount: 1 },
          ],
          tasks: [
            { memberId: M1, doneAt: null },
            { memberId: M2, doneAt: null },
            { memberId: M2, doneAt: null },
            { memberId: M1, doneAt: new Date('2026-06-10T09:00:00.000Z') }, // done today
            { memberId: M1, doneAt: new Date('2026-06-01T09:00:00.000Z') }, // earlier
          ],
          savings: [{ id: G1, name: 'Hajj fund', targetAmount: '5000.00' }],
          tx: [
            { savingsId: G1, amount: '300.00', type: 'deposit' },
            { savingsId: G1, amount: '50.00', type: 'withdrawal' },
          ],
          activity: [
            {
              id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
              action: 'completed a habit',
              createdAt: new Date('2026-06-10T08:00:00.000Z'),
              actor: 'Sarah',
            },
          ],
          mealsCount: 2,
        },
      );
      const res = await app.request('/api/dashboard/today');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        members: Array<{
          id: string;
          habitsDone: number;
          habitsTotal: number;
          streak: number;
          tasksPending: number;
          statusText: string;
        }>;
        counts: Record<string, number>;
        goals: Array<{ id: string; label: string; progress: number; target: number | null }>;
        recentActivity: Array<{
          id: string;
          actor: string | null;
          action: string;
          timestamp: string;
        }>;
      };

      const sarah = body.members.find((m) => m.id === M1)!;
      const iman = body.members.find((m) => m.id === M2)!;
      expect(sarah).toMatchObject({
        habitsDone: 2,
        habitsTotal: 2,
        streak: 1,
        tasksPending: 1,
        statusText: '1 task left',
      });
      expect(iman).toMatchObject({
        habitsDone: 1,
        habitsTotal: 2,
        streak: 1,
        tasksPending: 2,
        statusText: '2 tasks left',
      });
      expect(body.counts).toEqual({
        members: 2,
        habits: 2,
        rewards: 3,
        tasksDoneToday: 1,
        mealsPlanned: 2,
      });
      expect(body.goals).toEqual([{ id: G1, label: 'Hajj fund', progress: 250, target: 5000 }]);
      expect(body.recentActivity).toHaveLength(1);
      expect(body.recentActivity[0]).toMatchObject({
        actor: 'Sarah',
        action: 'completed a habit',
      });
      expect(body.recentActivity[0]!.timestamp).toBe('2026-06-10T08:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('de-duplicates habit completions and excludes archived-habit completions', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T12:00:00.000Z'));
    try {
      const M1 = '22222222-2222-4222-8222-222222222222';
      const H1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
      const H_ARCHIVED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9';
      const WK = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
      const app = buildAppWithSeed(
        {},
        {
          members: [{ id: M1, displayName: 'Sarah', role: 'admin', avatarEmoji: null }],
          habitIds: [H1], // only H1 is active; H_ARCHIVED is not returned by query 3
          weeks: [{ id: WK, startDate: '2026-06-08', endDate: '2026-06-14' }],
          actions: [
            { weekId: WK, memberId: M1, habitId: H1, completedCount: 1 },
            { weekId: WK, memberId: M1, habitId: H1, completedCount: 1 }, // duplicate row, same habit
            { weekId: WK, memberId: M1, habitId: H_ARCHIVED, completedCount: 5 }, // archived → excluded
          ],
        },
      );
      const res = await app.request('/api/dashboard/today');
      const body = (await res.json()) as {
        members: Array<{ habitsDone: number; habitsTotal: number; streak: number }>;
      };
      expect(body.members[0]).toMatchObject({ habitsDone: 1, habitsTotal: 1, streak: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a null activity actor as null rather than crashing', async () => {
    const app = buildAppWithSeed(
      {},
      {
        members: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            displayName: 'Sarah',
            role: 'admin',
            avatarEmoji: null,
          },
        ],
        activity: [
          {
            id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee9',
            action: 'family created',
            createdAt: new Date('2026-06-10T08:00:00.000Z'),
            actor: null, // system event / removed member
          },
        ],
      },
    );
    const res = await app.request('/api/dashboard/today');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recentActivity: Array<{ actor: string | null; action: string }>;
    };
    expect(body.recentActivity[0]).toEqual({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee9',
      actor: null,
      action: 'family created',
      timestamp: '2026-06-10T08:00:00.000Z',
    });
  });

  it('counts tasksDoneToday against the tenant timezone, not UTC', async () => {
    vi.useFakeTimers();
    // 20:30 UTC on Jun 10 is 00:30 Jun 11 in Asia/Dubai (+04) — "today" is Jun 11 there.
    vi.setSystemTime(new Date('2026-06-10T20:30:00.000Z'));
    try {
      const app = buildAppWithSeed(
        {},
        {
          tenantTimezone: 'Asia/Dubai',
          tasks: [
            {
              memberId: '22222222-2222-4222-8222-222222222222',
              doneAt: new Date('2026-06-10T20:30:00.000Z'),
            }, // Jun 11 Dubai → today
            {
              memberId: '22222222-2222-4222-8222-222222222222',
              doneAt: new Date('2026-06-10T08:00:00.000Z'),
            }, // Jun 10 Dubai → not today
          ],
        },
      );
      const res = await app.request('/api/dashboard/today');
      const body = (await res.json()) as { counts: { tasksDoneToday: number }; date: string };
      expect(body.date).toBe('2026-06-11');
      expect(body.counts.tasksDoneToday).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("anchors the date in the tenant's IANA timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T22:00:00.000Z'));
    try {
      const app = buildAppWithSeed({}, { tenantTimezone: 'Asia/Dubai' });
      const res = await app.request('/api/dashboard/today');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { date: string };
      expect(body.date).toBe('2026-05-04');
    } finally {
      vi.useRealTimers();
    }
  });
});
