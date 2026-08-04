import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mealsRouter } from '../../../../apps/api/src/routes/meals.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-229: GET + POST /api/meals. DB stubbed at module boundary; user
// + tenant context set via a tiny middleware. POST exercises the
// upsert + delete-on-empty paths and the role gate (admin/adult only).

const dbMock = {
  select: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
};
vi.mock('../../../../apps/api/src/db/client.js', () => ({
  getDb: () => dbMock,
}));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const USER_EMAIL = 'sarah@example.com';
const FIXED_USER: User = {
  id: USER_ID,
  email: USER_EMAIL,
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
  updatedAt: new Date('2026-05-01T00:00:00.000Z'),
};

interface SeedOpts {
  noTenant?: boolean;
  callerMissing?: boolean;
  callerRole?: string;
  // FHS-264: when a POST carries a memberId, the handler validates it
  // belongs to the tenant. memberMissing simulates a cross-tenant /
  // unknown member (validation query returns no row).
  memberMissing?: boolean;
}

function buildAppWithSeed(
  opts: SeedOpts = {},
  meals: unknown[] = [],
  upsertReturn: unknown[] = [],
) {
  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: USER_EMAIL, claims: {} });
    c.set('userRow', FIXED_USER);
    c.set('tenantId', opts.noTenant ? undefined : TENANT_ID);
    await next();
  };

  let selectCallIdx = 0;
  dbMock.select.mockImplementation(() => {
    selectCallIdx += 1;
    // 1: caller-membership lookup
    if (selectCallIdx === 1) {
      return {
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve(
                opts.callerMissing
                  ? []
                  : [{ id: 'caller-member-id', role: opts.callerRole ?? 'admin' }],
              ),
          }),
        }),
      };
    }
    // 2: GET meals list (.orderBy) OR POST member-validation (.limit).
    return {
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(meals),
          limit: () => Promise.resolve(opts.memberMissing ? [] : [{ id: 'target-member-id' }]),
        }),
      }),
    };
  });

  dbMock.insert.mockImplementation(() => ({
    values: () => ({
      onConflictDoUpdate: () => ({
        returning: () => Promise.resolve(upsertReturn),
      }),
    }),
  }));

  const deleteCalls: unknown[] = [];
  dbMock.delete.mockImplementation(() => ({
    where: (...args: unknown[]) => {
      deleteCalls.push(args);
      return Promise.resolve(undefined);
    },
  }));

  const app = new Hono();
  app.use('*', seed);
  app.route('/api/meals', mealsRouter);
  return { app, deleteCalls };
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
  dbMock.delete.mockReset();
});

describe('FHS-229: GET /api/meals', () => {
  it('returns 400 when no tenant is on the request', async () => {
    const { app } = buildAppWithSeed({ noTenant: true });
    const res = await app.request('/api/meals');
    expect(res.status).toBe(400);
  });

  it('returns 403 when the caller is not a member of the tenant', async () => {
    const { app } = buildAppWithSeed({ callerMissing: true });
    const res = await app.request('/api/meals');
    expect(res.status).toBe(403);
  });

  it('returns 200 with an empty list when no meals are stored', async () => {
    const { app } = buildAppWithSeed({}, []);
    const res = await app.request('/api/meals');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meals: unknown[] };
    expect(body.meals).toEqual([]);
  });

  it('returns the stored meal cells with day + slot + name + memberId + recurring', async () => {
    const M1 = '22222222-2222-4222-8222-222222222222';
    const MEMBER = '33333333-3333-4333-8333-333333333333';
    const { app } = buildAppWithSeed({}, [
      {
        id: M1,
        dayOfWeek: 'mon',
        slot: 'breakfast',
        name: 'Porridge',
        memberId: null,
        recurring: true,
      },
      {
        id: M1.replace(/2/g, '4'),
        dayOfWeek: 'mon',
        slot: 'breakfast',
        name: 'Eggs',
        memberId: MEMBER,
        recurring: false,
      },
    ]);
    const res = await app.request('/api/meals');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      meals: Array<{
        id: string;
        dayOfWeek: string;
        slot: string;
        name: string;
        memberId: string | null;
        recurring: boolean;
      }>;
    };
    // A whole-family meal and a per-member meal coexist on the same slot.
    expect(body.meals).toHaveLength(2);
    expect(body.meals[0]).toMatchObject({
      id: M1,
      dayOfWeek: 'mon',
      slot: 'breakfast',
      name: 'Porridge',
      memberId: null,
      recurring: true,
    });
    expect(body.meals[1]).toMatchObject({ name: 'Eggs', memberId: MEMBER, recurring: false });
  });
});

describe('FHS-229: POST /api/meals', () => {
  function postBody(body: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  it('returns 400 when no tenant is on the request', async () => {
    const { app } = buildAppWithSeed({ noTenant: true });
    const res = await app.request(
      '/api/meals',
      postBody({ dayOfWeek: 'mon', slot: 'breakfast', name: 'X' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 403 when caller has no membership', async () => {
    const { app } = buildAppWithSeed({ callerMissing: true });
    const res = await app.request(
      '/api/meals',
      postBody({ dayOfWeek: 'mon', slot: 'breakfast', name: 'X' }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 when caller's role is below adult (e.g. child)", async () => {
    const { app } = buildAppWithSeed({ callerRole: 'child' });
    const res = await app.request(
      '/api/meals',
      postBody({ dayOfWeek: 'mon', slot: 'breakfast', name: 'X' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 for teen role (not in WRITE_ROLES)', async () => {
    const { app } = buildAppWithSeed({ callerRole: 'teen' });
    const res = await app.request(
      '/api/meals',
      postBody({ dayOfWeek: 'mon', slot: 'breakfast', name: 'X' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 for guest role', async () => {
    const { app } = buildAppWithSeed({ callerRole: 'guest' });
    const res = await app.request(
      '/api/meals',
      postBody({ dayOfWeek: 'mon', slot: 'breakfast', name: 'X' }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 when slot is missing from the body', async () => {
    const { app } = buildAppWithSeed({});
    const res = await app.request('/api/meals', postBody({ dayOfWeek: 'mon', name: 'X' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when name exceeds 120 characters', async () => {
    const { app } = buildAppWithSeed({});
    const res = await app.request(
      '/api/meals',
      postBody({ dayOfWeek: 'mon', slot: 'breakfast', name: 'a'.repeat(121) }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects malformed body with 400', async () => {
    const { app } = buildAppWithSeed({});
    const res = await app.request(
      '/api/meals',
      postBody({ dayOfWeek: 'someday', slot: 'breakfast', name: 'X' }),
    );
    expect(res.status).toBe(400);
  });

  it('upserts and returns the saved cell when name is non-empty', async () => {
    const M1 = '22222222-2222-4222-8222-222222222222';
    const { app } = buildAppWithSeed(
      {},
      [],
      [
        {
          id: M1,
          dayOfWeek: 'mon',
          slot: 'lunch',
          name: 'Pasta',
          memberId: null,
          recurring: false,
        },
      ],
    );
    const res = await app.request(
      '/api/meals',
      postBody({ dayOfWeek: 'mon', slot: 'lunch', name: '  Pasta  ' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      name: string;
      memberId: string | null;
      recurring: boolean;
    };
    expect(body.name).toBe('Pasta');
    expect(body.memberId).toBeNull();
    expect(body.recurring).toBe(false);
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });

  it('persists memberId + recurring and returns them (valid member)', async () => {
    const M1 = '22222222-2222-4222-8222-222222222222';
    const MEMBER = '33333333-3333-4333-8333-333333333333';
    const { app } = buildAppWithSeed(
      {},
      [],
      [
        {
          id: M1,
          dayOfWeek: 'tue',
          slot: 'dinner',
          name: 'Curry',
          memberId: MEMBER,
          recurring: true,
        },
      ],
    );
    const res = await app.request(
      '/api/meals',
      postBody({
        dayOfWeek: 'tue',
        slot: 'dinner',
        name: 'Curry',
        memberId: MEMBER,
        recurring: true,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memberId: string | null; recurring: boolean };
    expect(body.memberId).toBe(MEMBER);
    expect(body.recurring).toBe(true);
  });

  it('returns 400 when memberId is not a member of this tenant', async () => {
    const MEMBER = '99999999-9999-4999-8999-999999999999';
    const { app } = buildAppWithSeed({ memberMissing: true });
    const res = await app.request(
      '/api/meals',
      postBody({ dayOfWeek: 'mon', slot: 'breakfast', name: 'X', memberId: MEMBER }),
    );
    expect(res.status).toBe(400);
    // No write happened: validation rejected before the upsert.
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('deletes the cell + returns { deleted: true } when name is empty', async () => {
    const { app, deleteCalls } = buildAppWithSeed({});
    const res = await app.request(
      '/api/meals',
      postBody({ dayOfWeek: 'mon', slot: 'lunch', name: '   ' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean };
    expect(body.deleted).toBe(true);
    expect(dbMock.delete).toHaveBeenCalledTimes(1);
    expect(deleteCalls).toHaveLength(1);
    // No insert happened on the empty path.
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});
