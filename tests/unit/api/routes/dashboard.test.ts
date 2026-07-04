import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dashboardRouter } from '../../../../apps/api/src/routes/dashboard.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-228 / FHS-262 / FHS-306 / FHS-439 — GET /api/dashboard/today.
//
// The route fires a fixed sequence of select() calls plus parallel
// stickerBalance() calls (which each do 2 selects). We stub db at the
// module boundary and stickerBalance separately. Derivation logic is
// covered in dashboard-helpers.test.ts; this file covers wiring + shape.
//
// FHS-439 added four new tenant-scoped queries (recent meals / calendar
// events / habit stickers / approved reward requests) so Recent Activity
// reflects what a real family actually does, not just the near-dead
// activity_logs table and the My World financial actions. Query sequence:
//   1  caller membership
//   2  members roster
//   3  active habits (family total for counts.habits)
//   4  rewards count
//   5  tenant timezone
//   6  weeks
//   7  tasks (also feeds "added"/"completed" Recent Activity entries)
//   8  savings
//   9  savings transactions
//   10 activityLogs (legacy feed)
//   11 mw_week_actions (My World feed)
//   12 recent meal templates (FHS-439)
//   13 recent calendar events (FHS-439)
//   14 recent habit stickers (FHS-439)
//   15 recent approved redemption requests (FHS-439)
//   16 meals count (countDistinct slot, today only)
//   17 kid habitsTotal (habits GROUP BY member_id) — only when kids exist
//   18 kid current mw_weeks (earliest non-finalized) — only when kids exist
//   19 kid habit_stickers (countDistinct habit_id per week) — only when open weeks exist

const dbMock = { select: vi.fn() };
vi.mock('../../../../apps/api/src/db/client.js', () => ({
  getDb: () => dbMock,
}));

// Stub stickerBalance so unit tests don't need to simulate its two inner
// selects. Default to returning 0; individual tests can override per call.
vi.mock('../../../../apps/api/src/lib/myworld.js', () => ({
  stickerBalance: vi.fn().mockResolvedValue(0),
}));

import { stickerBalance } from '../../../../apps/api/src/lib/myworld.js';
const stickerBalanceMock = vi.mocked(stickerBalance);

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
  // active habit rows for the family-level count (counts.habits)
  habitIds?: string[];
  rewardsCount?: number;
  tenantTimezone?: string | null;
  weeks?: Array<{ id: string; startDate: string; endDate: string }>;
  tasks?: Array<{
    id?: string;
    memberId: string | null;
    doneAt: Date | null;
    title?: string;
    createdAt?: Date;
  }>;
  savings?: Array<{ id: string; name: string; targetAmount: string | null }>;
  tx?: Array<{ savingsId: string; amount: string; type: 'deposit' | 'withdrawal' }>;
  activity?: Array<{ id: string; action: string; createdAt: Date; actor: string | null }>;
  mwActions?: Array<{
    id: string;
    memberId: string;
    actionType: string;
    stickersUsed: number | null;
    rewardName: string | null;
    habitName: string | null;
    createdAt: Date;
  }>;
  // FHS-439 — the four everyday Recent Activity sources.
  recentMeals?: Array<{
    id: string;
    name: string;
    slot: string;
    dayOfWeek: string;
    memberId: string | null;
    createdAt: Date;
  }>;
  recentEvents?: Array<{
    id: string;
    title: string;
    memberId: string | null;
    createdAt: Date;
  }>;
  recentStickers?: Array<{
    id: string;
    memberId: string;
    habitName: string | null;
    createdAt: Date;
  }>;
  recentApprovedRedemptions?: Array<{
    id: string;
    memberId: string;
    rewardName: string | null;
    decidedAt: Date | null;
    createdAt: Date;
  }>;
  mealsCount?: number;
  // Per-kid My World data:
  kidHabitsTotal?: Array<{ memberId: string; n: number }>;
  kidOpenWeeks?: Array<{ memberId: string; weekId: string; year: number; weekNumber: number }>;
  kidStickerCounts?: Array<{ memberId: string; weekId: string; n: number }>;
  stickerBalances?: Map<string, number>;
}

// A thenable that resolves to `rows` no matter where the builder chain
// stops (await db.select()...where()/orderBy()/leftJoin()/limit()/groupBy()).
function chain(rows: unknown): unknown {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    orderBy: () => obj,
    leftJoin: () => obj,
    limit: () => obj,
    groupBy: () => obj,
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

  // Determine whether kids exist (for conditional queries 17-19).
  const kidMembers = (data.members ?? []).filter((m) => m.role === 'child' || m.role === 'teen');
  const hasKids = kidMembers.length > 0;
  const hasOpenWeeks = hasKids && (data.kidOpenWeeks ?? []).length > 0;

  let idx = 0;
  dbMock.select.mockImplementation(() => {
    idx += 1;
    switch (idx) {
      case 1: // caller membership
        return chain(opts.callerMissing ? [] : [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }]);
      case 2: // members roster
        return chain(data.members ?? []);
      case 3: // active habit ids (family-level — no member_id filter)
        return chain((data.habitIds ?? []).map((id) => ({ id })));
      case 4: // rewards count
        return chain([{ n: data.rewardsCount ?? 0 }]);
      case 5: // tenant timezone
        return chain([{ timezone: data.tenantTimezone ?? 'UTC' }]);
      case 6: // weeks
        return chain(data.weeks ?? []);
      case 7: // tasks
        return chain(data.tasks ?? []);
      case 8: // savings
        return chain(data.savings ?? []);
      case 9: // savings transactions
        return chain(data.tx ?? []);
      case 10: // activityLogs (legacy feed)
        return chain(data.activity ?? []);
      case 11: // mw_week_actions (My World feed)
        return chain(data.mwActions ?? []);
      case 12: // FHS-439 — recent meal templates
        return chain(data.recentMeals ?? []);
      case 13: // FHS-439 — recent calendar events
        return chain(data.recentEvents ?? []);
      case 14: // FHS-439 — recent habit stickers
        return chain(data.recentStickers ?? []);
      case 15: // FHS-439 — recent approved redemption requests
        return chain(data.recentApprovedRedemptions ?? []);
      case 16: // meals count
        return chain([{ n: data.mealsCount ?? 0 }]);
      case 17: // kid habitsTotal (GROUP BY member_id) — only when kids exist
        if (!hasKids) return chain([{ n: 0 }]); // shouldn't be reached, but safe
        return chain((data.kidHabitsTotal ?? []).map((r) => ({ memberId: r.memberId, n: r.n })));
      case 18: // kid open mw_weeks — only when kids exist
        if (!hasKids) return chain([]);
        return chain(
          (data.kidOpenWeeks ?? []).map((r) => ({ memberId: r.memberId, weekId: r.weekId })),
        );
      case 19: // kid habit_stickers countDistinct — only when open weeks exist
        if (!hasOpenWeeks) return chain([]);
        return chain(
          (data.kidStickerCounts ?? []).map((r) => ({
            memberId: r.memberId,
            weekId: r.weekId,
            n: r.n,
          })),
        );
      default:
        return chain([]);
    }
  });

  // Configure stickerBalance per kid.
  stickerBalanceMock.mockImplementation(async (_db, _tenantId, memberId) => {
    return data.stickerBalances?.get(memberId) ?? 0;
  });

  const app = new Hono();
  app.use('*', seed);
  app.route('/api/dashboard', dashboardRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  stickerBalanceMock.mockReset();
  stickerBalanceMock.mockResolvedValue(0);
});

describe('FHS-228 / FHS-262 / FHS-306 — GET /api/dashboard/today', () => {
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
      tasksTotalToday: 0,
      mealsPlanned: 0,
    });
    expect(body.goals).toEqual([]);
    expect(body.recentActivity).toEqual([]);
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.greetingName).toBe('Sarah');
  });

  it('FHS-306 Fix 1+2: kid with a placed sticker shows habitsDone≥1 and positive starBalance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T12:00:00.000Z'));
    try {
      const M_KID = '33333333-3333-4333-8333-333333333333';
      const WK_MW = 'wwwwwwww-wwww-4www-8www-wwwwwwwwwww1';
      const app = buildAppWithSeed(
        {},
        {
          members: [
            { id: M_KID, displayName: 'Iman', role: 'child', avatarEmoji: null, userId: null },
          ],
          habitIds: [],
          kidHabitsTotal: [{ memberId: M_KID, n: 3 }],
          kidOpenWeeks: [{ memberId: M_KID, weekId: WK_MW, year: 2026, weekNumber: 24 }],
          kidStickerCounts: [{ memberId: M_KID, weekId: WK_MW, n: 2 }],
          stickerBalances: new Map([[M_KID, 7]]),
        },
      );
      const res = await app.request('/api/dashboard/today');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        members: Array<{
          id: string;
          habitsDone: number;
          habitsTotal: number;
          starBalance: number;
        }>;
      };
      const iman = body.members.find((m) => m.id === M_KID)!;
      expect(iman.habitsDone).toBe(2);
      expect(iman.habitsTotal).toBe(3);
      expect(iman.starBalance).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('FHS-306 Fix 1: kid with no current mw_week shows habitsDone=0', async () => {
    const M_KID = '33333333-3333-4333-8333-333333333333';
    const app = buildAppWithSeed(
      {},
      {
        members: [
          { id: M_KID, displayName: 'Iman', role: 'child', avatarEmoji: null, userId: null },
        ],
        kidHabitsTotal: [{ memberId: M_KID, n: 3 }],
        kidOpenWeeks: [], // no open week
        stickerBalances: new Map([[M_KID, 0]]),
      },
    );
    const res = await app.request('/api/dashboard/today');
    const body = (await res.json()) as {
      members: Array<{ id: string; habitsDone: number; habitsTotal: number }>;
    };
    const iman = body.members.find((m) => m.id === M_KID)!;
    expect(iman.habitsDone).toBe(0);
    expect(iman.habitsTotal).toBe(3);
  });

  it('FHS-306 Fix 3: mw_week_action appears in recentActivity with friendly label', async () => {
    const M_KID = '33333333-3333-4333-8333-333333333333';
    const MW_ACTION_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const app = buildAppWithSeed(
      {},
      {
        members: [
          { id: M_KID, displayName: 'Iman', role: 'child', avatarEmoji: null, userId: null },
        ],
        mwActions: [
          {
            id: MW_ACTION_ID,
            memberId: M_KID,
            actionType: 'claim',
            stickersUsed: null,
            rewardName: 'Ice cream',
            habitName: null,
            createdAt: new Date('2026-06-10T09:00:00.000Z'),
          },
        ],
      },
    );
    const res = await app.request('/api/dashboard/today');
    const body = (await res.json()) as {
      recentActivity: Array<{ id: string; actor: string | null; action: string }>;
    };
    const mwEntry = body.recentActivity.find((a) => a.id === MW_ACTION_ID)!;
    expect(mwEntry).toBeDefined();
    expect(mwEntry.actor).toBe('Iman');
    expect(mwEntry.action).toBe('claimed Ice cream');
  });

  it('FHS-439: merges all six activity sources, sorts desc, takes top 5', async () => {
    const M = '22222222-2222-4222-8222-222222222222';
    const app = buildAppWithSeed(
      {},
      {
        members: [{ id: M, displayName: 'Sarah', role: 'admin', avatarEmoji: null, userId: M }],
        activity: [
          {
            id: 'aaaaaaaa-0001-4aaa-8aaa-aaaaaaaaaaaa',
            action: 'oldest log',
            createdAt: new Date('2026-06-10T06:00:00.000Z'),
            actor: 'Sarah',
          },
          {
            id: 'aaaaaaaa-0002-4aaa-8aaa-aaaaaaaaaaaa',
            action: 'mid log',
            createdAt: new Date('2026-06-10T09:00:00.000Z'),
            actor: 'Sarah',
          },
        ],
        mwActions: [
          {
            id: 'bbbbbbbb-0001-4bbb-8bbb-bbbbbbbbbbbb',
            memberId: M,
            actionType: 'save',
            stickersUsed: 5,
            rewardName: null,
            habitName: null,
            createdAt: new Date('2026-06-10T11:00:00.000Z'),
          },
          {
            id: 'bbbbbbbb-0002-4bbb-8bbb-bbbbbbbbbbbb',
            memberId: M,
            actionType: 'cashout',
            stickersUsed: 3,
            rewardName: null,
            habitName: null,
            createdAt: new Date('2026-06-10T10:00:00.000Z'),
          },
        ],
        recentEvents: [
          {
            id: 'cccccccc-0001-4ccc-8ccc-cccccccccccc',
            title: 'Swimming lesson',
            memberId: M,
            createdAt: new Date('2026-06-10T12:00:00.000Z'),
          },
        ],
        recentApprovedRedemptions: [
          {
            id: 'dddddddd-0001-4ddd-8ddd-dddddddddddd',
            memberId: M,
            rewardName: 'Movie night',
            decidedAt: new Date('2026-06-10T08:00:00.000Z'),
            createdAt: new Date('2026-06-10T07:30:00.000Z'),
          },
        ],
      },
    );
    const res = await app.request('/api/dashboard/today');
    const body = (await res.json()) as {
      recentActivity: Array<{ id: string; action: string }>;
    };
    // 6 candidate entries sorted desc: event(12:00), save(11:00),
    // cashout(10:00), mid log(09:00), redemption(08:00) — oldest log
    // (06:00) is cut by the top-5 window.
    expect(body.recentActivity).toHaveLength(5);
    expect(body.recentActivity.map((a) => a.id)).toEqual([
      'cccccccc-0001-4ccc-8ccc-cccccccccccc',
      'bbbbbbbb-0001-4bbb-8bbb-bbbbbbbbbbbb',
      'bbbbbbbb-0002-4bbb-8bbb-bbbbbbbbbbbb',
      'aaaaaaaa-0002-4aaa-8aaa-aaaaaaaaaaaa',
      'dddddddd-0001-4ddd-8ddd-dddddddddddd',
    ]);
    expect(body.recentActivity[0]!.action).toBe('added "Swimming lesson" to the calendar');
    expect(body.recentActivity[4]!.action).toBe('got the "Movie night" reward approved');
  });

  it('FHS-439: a meal planned, a habit sticker placed, and a task added/completed all populate Recent Activity', async () => {
    const M = '22222222-2222-4222-8222-222222222222';
    const TASK_ID = '55555555-5555-4555-8555-555555555555';
    const app = buildAppWithSeed(
      {},
      {
        members: [{ id: M, displayName: 'Sarah', role: 'admin', avatarEmoji: null, userId: M }],
        tasks: [
          {
            id: TASK_ID,
            memberId: M,
            title: 'Pack school bag',
            createdAt: new Date('2026-06-10T07:00:00.000Z'),
            doneAt: new Date('2026-06-10T08:00:00.000Z'),
          },
        ],
        recentMeals: [
          {
            id: 'eeeeeeee-0001-4eee-8eee-eeeeeeeeeee1',
            name: 'Biryani',
            slot: 'dinner',
            dayOfWeek: 'tue',
            memberId: null,
            createdAt: new Date('2026-06-10T06:00:00.000Z'),
          },
        ],
        recentStickers: [
          {
            id: 'ffffffff-0001-4fff-8fff-ffffffffffff',
            memberId: M,
            habitName: 'Reading',
            createdAt: new Date('2026-06-10T05:00:00.000Z'),
          },
        ],
      },
    );
    const res = await app.request('/api/dashboard/today');
    const body = (await res.json()) as {
      recentActivity: Array<{ id: string; actor: string | null; action: string }>;
    };
    // A single task row contributes TWO distinct entries (added + completed)
    // sharing the same underlying id but with a `:created` / `:completed`
    // suffix so they never collide as React keys.
    const added = body.recentActivity.find((a) => a.id === `${TASK_ID}:created`)!;
    const completed = body.recentActivity.find((a) => a.id === `${TASK_ID}:completed`)!;
    expect(added.action).toBe('added a task: "Pack school bag"');
    expect(completed.action).toBe('completed a task: "Pack school bag"');
    expect(added.actor).toBe('Sarah');

    const meal = body.recentActivity.find((a) => a.id === 'eeeeeeee-0001-4eee-8eee-eeeeeeeeeee1')!;
    expect(meal.action).toBe('planned "Biryani" for Tuesday dinner');
    expect(meal.actor).toBeNull(); // whole-family meal, no member_id

    const sticker = body.recentActivity.find(
      (a) => a.id === 'ffffffff-0001-4fff-8fff-ffffffffffff',
    )!;
    expect(sticker.action).toBe('earned a sticker for "Reading"');
    expect(sticker.actor).toBe('Sarah');
  });

  it('FHS-439: stays empty only when every source is genuinely empty', async () => {
    const app = buildAppWithSeed(
      {},
      {
        members: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            displayName: 'Sarah',
            role: 'admin',
            avatarEmoji: null,
            userId: '22222222-2222-4222-8222-222222222222',
          },
        ],
      },
    );
    const res = await app.request('/api/dashboard/today');
    const body = (await res.json()) as { recentActivity: unknown[] };
    expect(body.recentActivity).toEqual([]);
  });

  it('derives per-member stats, snapshot counts, goals and activity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T12:00:00.000Z')); // Wed
    try {
      const M1 = '22222222-2222-4222-8222-222222222222';
      const M2 = '33333333-3333-4333-8333-333333333333';
      const WK_MW = 'wwwwwwww-wwww-4www-8www-wwwwwwwwwww1';
      const G1 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
      const app = buildAppWithSeed(
        {},
        {
          members: [
            { id: M1, displayName: 'Sarah', role: 'admin', avatarEmoji: '👩', userId: USER_ID },
            { id: M2, displayName: 'Iman', role: 'child', avatarEmoji: null, userId: null },
          ],
          habitIds: ['h1', 'h2'], // family-level count = 2 for counts.habits
          rewardsCount: 3,
          weeks: [{ id: 'wk1', startDate: '2026-06-08', endDate: '2026-06-14' }],
          tasks: [
            {
              id: 't1',
              memberId: M1,
              doneAt: null,
              title: 'Call plumber',
              createdAt: new Date('2026-06-10T07:00:00.000Z'),
            },
            {
              id: 't2',
              memberId: M1,
              doneAt: null,
              title: 'Grocery run & Bills',
              createdAt: new Date('2026-06-09T08:00:00.000Z'),
            },
            {
              id: 't3',
              memberId: M2,
              doneAt: null,
              title: 'Tidy room',
              createdAt: new Date('2026-06-09T09:00:00.000Z'),
            },
            {
              id: 't4',
              memberId: M2,
              doneAt: null,
              title: 'Pack bag',
              createdAt: new Date('2026-06-09T10:00:00.000Z'),
            },
            {
              id: 't5',
              memberId: M1,
              doneAt: new Date('2026-06-10T09:00:00.000Z'),
              title: 'Done one',
              createdAt: new Date('2026-06-08T09:00:00.000Z'),
            },
            {
              id: 't6',
              memberId: M1,
              doneAt: new Date('2026-06-01T09:00:00.000Z'),
              title: 'Old one',
              createdAt: new Date('2026-05-30T09:00:00.000Z'),
            },
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
          // FHS-306: per-kid My World data for Iman.
          kidHabitsTotal: [{ memberId: M2, n: 2 }],
          kidOpenWeeks: [{ memberId: M2, weekId: WK_MW, year: 2026, weekNumber: 24 }],
          kidStickerCounts: [{ memberId: M2, weekId: WK_MW, n: 1 }],
          stickerBalances: new Map([[M2, 1]]),
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
          starBalance: number;
          pendingSignup: boolean;
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
        habitsDone: 0, // adults have no My World habits
        habitsTotal: 0,
        tasksPending: 2,
        statusText: 'Call plumber',
        starBalance: 0,
        pendingSignup: false,
      });
      expect(iman).toMatchObject({
        habitsDone: 1, // from habit_stickers via My World
        habitsTotal: 2, // from habits.member_id
        tasksPending: 2,
        statusText: '2 tasks left',
        starBalance: 1, // from stickerBalance()
        pendingSignup: false,
      });
      expect(body.counts).toEqual({
        members: 2,
        habits: 2,
        rewards: 3,
        tasksDoneToday: 1,
        tasksTotalToday: 5,
        mealsPlanned: 2,
      });
      expect(body.goals).toEqual([{ id: G1, label: 'Hajj fund', progress: 250, target: 5000 }]);
      // FHS-439 — tasks now also feed the merged feed, so the legacy
      // activityLogs entry is no longer the only one; just confirm it's
      // still present somewhere in the top-5 window.
      expect(body.recentActivity.length).toBeGreaterThan(0);
      expect(
        body.recentActivity.some((a) => a.actor === 'Sarah' && a.action === 'completed a habit'),
      ).toBe(true);
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
            actor: null,
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
    vi.setSystemTime(new Date('2026-06-10T20:30:00.000Z'));
    try {
      const app = buildAppWithSeed(
        {},
        {
          tenantTimezone: 'Asia/Dubai',
          tasks: [
            {
              id: 'dubai-1',
              memberId: '22222222-2222-4222-8222-222222222222',
              doneAt: new Date('2026-06-10T20:30:00.000Z'),
              createdAt: new Date('2026-06-10T07:00:00.000Z'),
            },
            {
              id: 'dubai-2',
              memberId: '22222222-2222-4222-8222-222222222222',
              doneAt: new Date('2026-06-10T08:00:00.000Z'),
              createdAt: new Date('2026-06-09T07:00:00.000Z'),
            },
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

  it('FHS-306 Fix 3: mw_week_actions action labels cover all action types', async () => {
    const M = '22222222-2222-4222-8222-222222222222';
    const ACTION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const mkAction = (
      actionType: string,
      extra: Partial<{
        stickersUsed: number;
        rewardName: string;
        habitName: string;
      }> = {},
    ) => ({
      id: ACTION_ID,
      memberId: M,
      actionType,
      stickersUsed: extra.stickersUsed ?? null,
      rewardName: extra.rewardName ?? null,
      habitName: extra.habitName ?? null,
      createdAt: new Date(1000000),
    });
    const cases: Array<[string, string, Parameters<typeof mkAction>[1]]> = [
      ['cashout', 'cashed out 4⭐', { stickersUsed: 4 }],
      ['save', 'saved 2⭐', { stickersUsed: 2 }],
      ['invest', 'invested 10⭐ in Reading', { stickersUsed: 10, habitName: 'Reading' }],
      ['withdraw', 'withdrew from Maths', { habitName: 'Maths' }],
      ['auto_save', 'auto-saved 3⭐', { stickersUsed: 3 }],
      ['invest_continue', 'carried over Running', { habitName: 'Running' }],
    ];
    for (const [actionType, expected, extra] of cases) {
      const app = buildAppWithSeed(
        {},
        {
          members: [{ id: M, displayName: 'Iman', role: 'child', avatarEmoji: null, userId: null }],
          mwActions: [mkAction(actionType, extra)],
        },
      );
      const res = await app.request('/api/dashboard/today');
      const body = (await res.json()) as {
        recentActivity: Array<{ action: string }>;
      };
      expect(body.recentActivity[0]!.action, `actionType=${actionType}`).toBe(expected);
    }
  });
});
