import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { habitsRouter } from '../../../../apps/api/src/routes/habits.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-292 — auth/tenant/role guards for /api/habits (sticker model). The
// DB-backed behaviour (sticker placement, balance, week creation) is
// covered by the myworld integration tests.

const dbMock = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() };
vi.mock('../../../../apps/api/src/db/client.js', () => ({ getDb: () => dbMock }));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const MEMBER_ID = '44444444-4444-4444-8444-444444444444';
const HABIT_ID = '55555555-5555-4555-8555-555555555555';
const WEEK_ID = '66666666-6666-4666-8666-666666666666';
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
  app.route('/api/habits', habitsRouter);
  return app;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
  dbMock.update.mockReset();
  dbMock.delete.mockReset();
});

describe('FHS-292 — GET /api/habits guards', () => {
  it('400 when no tenant context', async () => {
    const res = await buildApp({ noTenant: true }).request(`/api/habits?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(400);
  });
  it('400 when memberId is missing', async () => {
    const res = await buildApp().request('/api/habits');
    expect(res.status).toBe(400);
  });
  it('403 when the caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(`/api/habits?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(403);
  });
  it('404 when the target member is not in the tenant', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'admin' }], []] }).request(
      `/api/habits?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(404);
  });
  it('403 when a non-parent caller targets another member', async () => {
    const res = await buildApp({
      memberChecks: [[{ id: 'caller', role: 'teen' }], [{ id: MEMBER_ID }]],
    }).request(`/api/habits?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(403);
  });
});

describe('FHS-292 — POST /api/habits guards', () => {
  it('400 on an empty name', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'admin' }]] }).request(
      '/api/habits',
      json('POST', { memberId: MEMBER_ID, name: '   ' }),
    );
    expect(res.status).toBe(400);
  });
  it('403 when the caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      '/api/habits',
      json('POST', { memberId: MEMBER_ID, name: 'Read' }),
    );
    expect(res.status).toBe(403);
  });
  it('404 when the target member is absent', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'admin' }], []] }).request(
      '/api/habits',
      json('POST', { memberId: MEMBER_ID, name: 'Read' }),
    );
    expect(res.status).toBe(404);
  });
});

describe('FHS-292 — sticker placement guards', () => {
  it('400 on an out-of-range day', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'admin' }]] }).request(
      `/api/habits/${HABIT_ID}/stickers`,
      json('POST', { memberId: MEMBER_ID, weekId: WEEK_ID, day: 9, sticker: 'gold-star' }),
    );
    expect(res.status).toBe(400);
  });
  it('400 on an unknown sticker type', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'admin' }]] }).request(
      `/api/habits/${HABIT_ID}/stickers`,
      json('POST', { memberId: MEMBER_ID, weekId: WEEK_ID, day: 0, sticker: 'diamond' }),
    );
    expect(res.status).toBe(400);
  });
  it('403 when a non-parent caller targets another member', async () => {
    const res = await buildApp({
      memberChecks: [[{ id: 'caller', role: 'teen' }], [{ id: MEMBER_ID }]],
    }).request(
      `/api/habits/${HABIT_ID}/stickers`,
      json('POST', { memberId: MEMBER_ID, weekId: WEEK_ID, day: 0, sticker: 'gold-star' }),
    );
    expect(res.status).toBe(403);
  });
});

// FHS-342 — managing the habit list is admin-only. A normal user (adult)
// passes membership but is rejected before the mutation.
describe('FHS-342 — habit create/update/delete are admin-only', () => {
  it('POST a habit as a normal user → 403 ADMIN_ONLY', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'adult' }]] }).request(
      '/api/habits',
      json('POST', { memberId: MEMBER_ID, name: 'Read' }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe('ADMIN_ONLY');
  });
  it('PUT a habit as a normal user → 403', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'adult' }]] }).request(
      `/api/habits/${HABIT_ID}`,
      json('PUT', { memberId: MEMBER_ID, name: 'Renamed' }),
    );
    expect(res.status).toBe(403);
  });
  it('DELETE a habit as a normal user → 403', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'adult' }]] }).request(
      `/api/habits/${HABIT_ID}`,
      json('DELETE', { memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(403);
  });
});

describe('FHS-292 — DELETE /api/habits/:id guards', () => {
  it('400 on a non-UUID id', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'admin' }]] }).request(
      '/api/habits/not-a-uuid',
      { method: 'DELETE' },
    );
    expect(res.status).toBe(400);
  });
  it('403 when the caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(`/api/habits/${HABIT_ID}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(403);
  });
});

// FHS-335 — editing a PAST-day sticker is admin-only; today and later days in
// the current week stay open to a normal user (adult). System clock is pinned
// to Wed 2026-06-17, so the week's Monday is 2026-06-15:
//   day 0 = Mon (past) · day 2 = Wed (today) · day 3 = Thu (later this week).
describe('FHS-335 — past-day sticker edits are admin-only', () => {
  const WEEK = { startDate: '2026-06-15', isFinalized: false };
  const HABIT = { id: HABIT_ID, boost: 1 };
  const okInsert = () => ({
    values: () => ({ onConflictDoUpdate: () => Promise.resolve(undefined) }),
  });
  const okDelete = () => ({ where: () => Promise.resolve(undefined) });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  function place(day: number, opts: { role: string; week?: typeof WEEK }) {
    const app = buildApp({
      memberChecks: [
        [{ id: 'caller', role: opts.role }],
        [{ id: MEMBER_ID }],
        [opts.week ?? WEEK],
        [HABIT],
      ],
    });
    dbMock.insert.mockImplementation(okInsert);
    return app.request(
      `/api/habits/${HABIT_ID}/stickers`,
      json('POST', { memberId: MEMBER_ID, weekId: WEEK_ID, day, sticker: 'gold-star' }),
    );
  }

  it('a normal user (adult) can place TODAY’s sticker → 200', async () => {
    expect((await place(2, { role: 'adult' })).status).toBe(200);
  });
  it('a normal user (adult) is blocked from a PAST day → 403 ADMIN_ONLY', async () => {
    const res = await place(0, { role: 'adult' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe('ADMIN_ONLY');
  });
  it('a child editing their OWN past day is blocked → 403 (the primary case)', async () => {
    // caller IS the member (self), so canManage passes — the gate must still block.
    const app = buildApp({
      memberChecks: [[{ id: MEMBER_ID, role: 'child' }], [{ id: MEMBER_ID }], [WEEK]],
    });
    dbMock.insert.mockImplementation(okInsert);
    const res = await app.request(
      `/api/habits/${HABIT_ID}/stickers`,
      json('POST', { memberId: MEMBER_ID, weekId: WEEK_ID, day: 0, sticker: 'gold-star' }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe('ADMIN_ONLY');
  });
  it('a child can still tick their OWN sticker for today → 200', async () => {
    const app = buildApp({
      memberChecks: [[{ id: MEMBER_ID, role: 'child' }], [{ id: MEMBER_ID }], [WEEK], [HABIT]],
    });
    dbMock.insert.mockImplementation(okInsert);
    const res = await app.request(
      `/api/habits/${HABIT_ID}/stickers`,
      json('POST', { memberId: MEMBER_ID, weekId: WEEK_ID, day: 2, sticker: 'gold-star' }),
    );
    expect(res.status).toBe(200);
  });
  it('an admin can place a PAST day’s sticker → 200', async () => {
    expect((await place(0, { role: 'admin' })).status).toBe(200);
  });
  it('a later day in the CURRENT week is allowed for a normal user → 200', async () => {
    // Future-within-the-week stays open (legacy "tick the whole week" behaviour);
    // only PAST days are admin-only.
    expect((await place(3, { role: 'adult' })).status).toBe(200);
  });
  it('a normal user is blocked from editing a FINALIZED week → 403', async () => {
    const res = await place(2, {
      role: 'adult',
      week: { startDate: '2026-06-15', isFinalized: true },
    });
    expect(res.status).toBe(403);
  });

  it('removing a PAST-day sticker is admin-only → 403 for a normal user', async () => {
    const app = buildApp({
      memberChecks: [[{ id: 'caller', role: 'adult' }], [{ id: MEMBER_ID }], [WEEK]],
    });
    dbMock.delete.mockImplementation(okDelete);
    const res = await app.request(
      `/api/habits/${HABIT_ID}/stickers`,
      json('DELETE', { memberId: MEMBER_ID, weekId: WEEK_ID, day: 0 }),
    );
    expect(res.status).toBe(403);
  });
  it('an admin can remove a PAST-day sticker → 204', async () => {
    const app = buildApp({
      memberChecks: [[{ id: 'caller', role: 'admin' }], [{ id: MEMBER_ID }], [WEEK]],
    });
    dbMock.delete.mockImplementation(okDelete);
    const res = await app.request(
      `/api/habits/${HABIT_ID}/stickers`,
      json('DELETE', { memberId: MEMBER_ID, weekId: WEEK_ID, day: 0 }),
    );
    expect(res.status).toBe(204);
  });
});

// FHS-512 — a completed day places stickerValue = habit.boost (replaces the
// old hardcoded isBonus ? 5 : 1). MONEY-CRITICAL: this is what determines how
// many stickers (and therefore how much money) a completion is worth.
describe('FHS-512 — sticker value comes from habit.boost', () => {
  const WEEK = { startDate: '2026-06-15', isFinalized: false };

  function placeOn(habit: { id: string; boost: number }) {
    let insertedValues: Record<string, unknown> | undefined;
    const app = buildApp({
      memberChecks: [[{ id: 'caller', role: 'admin' }], [{ id: MEMBER_ID }], [WEEK], [habit]],
    });
    dbMock.insert.mockImplementation(() => ({
      values: (v: Record<string, unknown>) => {
        insertedValues = v;
        return { onConflictDoUpdate: () => Promise.resolve(undefined) };
      },
    }));
    return app
      .request(
        `/api/habits/${HABIT_ID}/stickers`,
        json('POST', { memberId: MEMBER_ID, weekId: WEEK_ID, day: 2, sticker: 'gold-star' }),
      )
      .then(async (res) => ({
        res,
        body: (await res.json()) as { stickerValue: number },
        insertedValues,
      }));
  }

  it('a normal (boost=1) habit places a 1-value sticker', async () => {
    const { res, body, insertedValues } = await placeOn({ id: HABIT_ID, boost: 1 });
    expect(res.status).toBe(200);
    expect(body.stickerValue).toBe(1);
    expect(insertedValues?.stickerValue).toBe(1);
  });

  it('a boost=5 habit places a 5-value sticker (the old fixed "bonus" value)', async () => {
    const { res, body, insertedValues } = await placeOn({ id: HABIT_ID, boost: 5 });
    expect(res.status).toBe(200);
    expect(body.stickerValue).toBe(5);
    expect(insertedValues?.stickerValue).toBe(5);
  });

  it('a boost=3 habit (a UI preset) places a 3-value sticker', async () => {
    const { body } = await placeOn({ id: HABIT_ID, boost: 3 });
    expect(body.stickerValue).toBe(3);
  });
});

// FHS-512 — habit create/update validation for the new money fields.
describe('FHS-512 — habit boost + skipPenaltyMinor validation', () => {
  it('400 when boost is 0 (must be at least 1)', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'admin' }]] }).request(
      '/api/habits',
      json('POST', { memberId: MEMBER_ID, name: 'Read', boost: 0 }),
    );
    expect(res.status).toBe(400);
  });
  it('400 when boost exceeds the max (20)', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'admin' }]] }).request(
      '/api/habits',
      json('POST', { memberId: MEMBER_ID, name: 'Read', boost: 21 }),
    );
    expect(res.status).toBe(400);
  });
  it('400 when boost is not an integer', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'admin' }]] }).request(
      '/api/habits',
      json('POST', { memberId: MEMBER_ID, name: 'Read', boost: 2.5 }),
    );
    expect(res.status).toBe(400);
  });
  it('400 when skipPenaltyMinor is negative', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'admin' }]] }).request(
      '/api/habits',
      json('POST', { memberId: MEMBER_ID, name: 'Read', skipPenaltyMinor: -1 }),
    );
    expect(res.status).toBe(400);
  });

  // FIX 3 (BLOCKER) — no upper bound let an oversized penalty reach
  // Postgres' numeric(12,2) column and 500.
  it('400 when skipPenaltyMinor exceeds the cap (100000 = 1000.00)', async () => {
    const res = await buildApp({ memberChecks: [[{ id: 'caller', role: 'admin' }]] }).request(
      '/api/habits',
      json('POST', { memberId: MEMBER_ID, name: 'Read', skipPenaltyMinor: 100001 }),
    );
    expect(res.status).toBe(400);
  });

  it('POST with explicit boost=3 creates the habit with boost=3 and isBonus derived true', async () => {
    let insertedValues: Record<string, unknown> | undefined;
    const app = buildApp({
      memberChecks: [[{ id: 'caller', role: 'admin' }], [{ id: MEMBER_ID }]],
    });
    dbMock.insert.mockImplementation(() => ({
      values: (v: Record<string, unknown>) => {
        insertedValues = v;
        return { returning: () => Promise.resolve([{ description: null, ...v, id: HABIT_ID }]) };
      },
    }));
    const res = await app.request(
      '/api/habits',
      json('POST', { memberId: MEMBER_ID, name: 'Read', boost: 3, skipPenaltyMinor: 100 }),
    );
    expect(res.status).toBe(201);
    expect(insertedValues?.boost).toBe(3);
    expect(insertedValues?.skipPenaltyMinor).toBe(100);
    expect(insertedValues?.isBonus).toBe(true);
    const body = (await res.json()) as {
      boost: number;
      skipPenaltyMinor: number;
      isBonus: boolean;
    };
    expect(body.boost).toBe(3);
    expect(body.skipPenaltyMinor).toBe(100);
    expect(body.isBonus).toBe(true);
  });

  it('POST with legacy isBonus=true and no boost falls back to boost=5 (old fixed bonus value)', async () => {
    let insertedValues: Record<string, unknown> | undefined;
    const app = buildApp({
      memberChecks: [[{ id: 'caller', role: 'admin' }], [{ id: MEMBER_ID }]],
    });
    dbMock.insert.mockImplementation(() => ({
      values: (v: Record<string, unknown>) => {
        insertedValues = v;
        return { returning: () => Promise.resolve([{ description: null, ...v, id: HABIT_ID }]) };
      },
    }));
    const res = await app.request(
      '/api/habits',
      json('POST', { memberId: MEMBER_ID, name: 'Read', isBonus: true }),
    );
    expect(res.status).toBe(201);
    expect(insertedValues?.boost).toBe(5);
  });

  it('POST with no boost/isBonus defaults to boost=1, isBonus=false', async () => {
    let insertedValues: Record<string, unknown> | undefined;
    const app = buildApp({
      memberChecks: [[{ id: 'caller', role: 'admin' }], [{ id: MEMBER_ID }]],
    });
    dbMock.insert.mockImplementation(() => ({
      values: (v: Record<string, unknown>) => {
        insertedValues = v;
        return { returning: () => Promise.resolve([{ description: null, ...v, id: HABIT_ID }]) };
      },
    }));
    const res = await app.request(
      '/api/habits',
      json('POST', { memberId: MEMBER_ID, name: 'Read' }),
    );
    expect(res.status).toBe(201);
    expect(insertedValues?.boost).toBe(1);
    expect(insertedValues?.skipPenaltyMinor).toBe(0);
    expect(insertedValues?.isBonus).toBe(false);
  });

  it('PUT with an explicit boost updates both boost and the derived isBonus', async () => {
    let setPatch: Record<string, unknown> | undefined;
    const app = buildApp({
      memberChecks: [[{ id: 'caller', role: 'admin' }], [{ id: MEMBER_ID }]],
    });
    dbMock.update.mockImplementation(() => ({
      set: (patch: Record<string, unknown>) => {
        setPatch = patch;
        return {
          where: () => ({
            returning: () =>
              Promise.resolve([
                {
                  id: HABIT_ID,
                  name: 'Read',
                  description: null,
                  color: '#fff',
                  icon: null,
                  skipPenaltyMinor: 0,
                  ...patch,
                },
              ]),
          }),
        };
      },
    }));
    const res = await app.request(
      `/api/habits/${HABIT_ID}`,
      json('PUT', { memberId: MEMBER_ID, boost: 2 }),
    );
    expect(res.status).toBe(200);
    expect(setPatch?.boost).toBe(2);
    expect(setPatch?.isBonus).toBe(true);
  });

  it('PUT with boost=1 explicitly derives isBonus=false', async () => {
    let setPatch: Record<string, unknown> | undefined;
    const app = buildApp({
      memberChecks: [[{ id: 'caller', role: 'admin' }], [{ id: MEMBER_ID }]],
    });
    dbMock.update.mockImplementation(() => ({
      set: (patch: Record<string, unknown>) => {
        setPatch = patch;
        return {
          where: () => ({
            returning: () =>
              Promise.resolve([
                {
                  id: HABIT_ID,
                  name: 'Read',
                  description: null,
                  color: '#fff',
                  icon: null,
                  skipPenaltyMinor: 0,
                  ...patch,
                },
              ]),
          }),
        };
      },
    }));
    const res = await app.request(
      `/api/habits/${HABIT_ID}`,
      json('PUT', { memberId: MEMBER_ID, boost: 1 }),
    );
    expect(res.status).toBe(200);
    expect(setPatch?.boost).toBe(1);
    expect(setPatch?.isBonus).toBe(false);
  });
});
