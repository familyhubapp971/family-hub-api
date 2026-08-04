import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noticesRouter } from '../../../../apps/api/src/routes/notices.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-232: GET / POST / DELETE /api/notices.

const dbMock = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
// Captures the object passed to the most recent `.update(...).set({...})`
// so PUT tests can assert which columns are (and are NOT) written.
let lastUpdateSet: Record<string, unknown> | null = null;
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
}

function buildAppWithSeed(
  opts: SeedOpts = {},
  listRows: unknown[] = [],
  insertReturn: unknown[] = [],
  deleteReturn: unknown[] = [],
  updateReturn: unknown[] = [],
) {
  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: USER_EMAIL, claims: {} });
    c.set('userRow', FIXED_USER);
    c.set('tenantId', opts.noTenant ? undefined : TENANT_ID);
    await next();
  };

  let selectIdx = 0;
  dbMock.select.mockImplementation(() => {
    selectIdx += 1;
    if (selectIdx === 1) {
      return {
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve(
                opts.callerMissing
                  ? []
                  : [{ id: 'caller-member-id', role: opts.callerRole ?? 'admin', name: 'Sarah' }],
              ),
          }),
        }),
      };
    }
    // selectIdx >= 2 covers two cases:
    //   • GET list: leftJoin().where().orderBy()
    //   • PUT author lookup: where().limit()  (no leftJoin, no orderBy)
    return {
      from: () => ({
        leftJoin: () => ({
          where: () => ({ orderBy: () => Promise.resolve(listRows) }),
        }),
        where: () => ({
          orderBy: () => Promise.resolve(listRows),
          limit: () => Promise.resolve([]), // author lookup returns no row → authorName null
        }),
      }),
    };
  });

  dbMock.insert.mockImplementation(() => ({
    values: () => ({ returning: () => Promise.resolve(insertReturn) }),
  }));
  dbMock.update.mockImplementation(() => ({
    set: (arg: Record<string, unknown>) => {
      lastUpdateSet = arg;
      return { where: () => ({ returning: () => Promise.resolve(updateReturn) }) };
    },
  }));
  dbMock.delete.mockImplementation(() => ({
    where: () => ({ returning: () => Promise.resolve(deleteReturn) }),
  }));

  const app = new Hono();
  app.use('*', seed);
  app.route('/api/notices', noticesRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
  dbMock.update.mockReset();
  dbMock.delete.mockReset();
  lastUpdateSet = null;
});

describe('FHS-232: GET /api/notices', () => {
  it('returns 400 when no tenant', async () => {
    const app = buildAppWithSeed({ noTenant: true });
    const res = await app.request('/api/notices');
    expect(res.status).toBe(400);
  });

  it('returns 403 when caller is not a member', async () => {
    const app = buildAppWithSeed({ callerMissing: true });
    const res = await app.request('/api/notices');
    expect(res.status).toBe(403);
  });

  it('returns 200 with empty list when none exist', async () => {
    const app = buildAppWithSeed({}, []);
    const res = await app.request('/api/notices');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notices: unknown[] };
    expect(body.notices).toEqual([]);
  });

  it('returns notices serialised with createdAt as ISO + pinned flag', async () => {
    const N1 = '22222222-2222-4222-8222-222222222222';
    const created = new Date('2026-05-03T10:00:00.000Z');
    const app = buildAppWithSeed({}, [
      {
        id: N1,
        body: 'Pizza Friday',
        pinned: true,
        authorMemberId: null,
        authorName: null,
        icon: '🍕',
        createdAt: created,
      },
    ]);
    const res = await app.request('/api/notices');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notices: Array<{ id: string; body: string; pinned: boolean; createdAt: string }>;
    };
    expect(body.notices[0]).toMatchObject({
      id: N1,
      body: 'Pizza Friday',
      pinned: true,
      createdAt: created.toISOString(),
    });
  });
});

describe('FHS-232: POST /api/notices', () => {
  function postBody(body: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  it('returns 403 for child/teen/guest roles', async () => {
    for (const callerRole of ['child', 'teen', 'guest']) {
      const app = buildAppWithSeed({ callerRole });
      const res = await app.request('/api/notices', postBody({ body: 'X' }));
      expect(res.status, `role ${callerRole}`).toBe(403);
    }
  });

  it('returns 400 when body is empty after trim', async () => {
    const app = buildAppWithSeed({});
    const res = await app.request('/api/notices', postBody({ body: '   ' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when body exceeds 2000 chars', async () => {
    const app = buildAppWithSeed({});
    const res = await app.request('/api/notices', postBody({ body: 'a'.repeat(2001) }));
    expect(res.status).toBe(400);
  });

  it('returns 201 with the created notice (pinned defaults to false)', async () => {
    const N1 = '22222222-2222-4222-8222-222222222222';
    const created = new Date('2026-05-03T10:00:00.000Z');
    const app = buildAppWithSeed(
      {},
      [],
      [
        {
          id: N1,
          body: 'Pizza Friday',
          pinned: false,
          authorMemberId: '44444444-4444-4444-8444-444444444444',
          icon: null,
          createdAt: created,
        },
      ],
    );
    const res = await app.request('/api/notices', postBody({ body: 'Pizza Friday' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; pinned: boolean };
    expect(body.id).toBe(N1);
    expect(body.pinned).toBe(false);
  });

  it('returns 201 with pinned=true when body sets it', async () => {
    const N1 = '33333333-3333-4333-8333-333333333333';
    const created = new Date('2026-05-03T10:00:00.000Z');
    const app = buildAppWithSeed(
      {},
      [],
      [
        {
          id: N1,
          body: 'Trip on Sat',
          pinned: true,
          authorMemberId: '44444444-4444-4444-8444-444444444444',
          icon: null,
          createdAt: created,
        },
      ],
    );
    const res = await app.request('/api/notices', postBody({ body: 'Trip on Sat', pinned: true }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { pinned: boolean };
    expect(body.pinned).toBe(true);
  });
});

describe('FHS-310: PUT /api/notices/:id', () => {
  const N1 = '22222222-2222-4222-8222-222222222222';
  const created = new Date('2026-05-03T10:00:00.000Z');
  const AUTHOR_MEMBER_ID = '44444444-4444-4444-8444-444444444444';

  function putBody(body: unknown): RequestInit {
    return {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  it('returns 200 with updated body/pinned/icon', async () => {
    const app = buildAppWithSeed(
      {},
      [],
      [],
      [],
      [
        {
          id: N1,
          body: 'Updated notice',
          pinned: true,
          authorMemberId: AUTHOR_MEMBER_ID,
          icon: '🎉',
          createdAt: created,
        },
      ],
    );
    const res = await app.request(
      `/api/notices/${N1}`,
      putBody({ body: 'Updated notice', pinned: true, icon: '🎉' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      body: string;
      pinned: boolean;
      icon: string | null;
    };
    expect(body.id).toBe(N1);
    expect(body.body).toBe('Updated notice');
    expect(body.pinned).toBe(true);
    expect(body.icon).toBe('🎉');
  });

  it('preserves authorMemberId: PUT never reassigns authorship', async () => {
    const app = buildAppWithSeed(
      {},
      [],
      [],
      [],
      [
        {
          id: N1,
          body: 'Hello',
          pinned: false,
          authorMemberId: AUTHOR_MEMBER_ID,
          icon: null,
          createdAt: created,
        },
      ],
    );
    const res = await app.request(`/api/notices/${N1}`, putBody({ body: 'Hello' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorMemberId: string | null };
    expect(body.authorMemberId).toBe(AUTHOR_MEMBER_ID);
    // The real lock: authorMemberId must NOT be among the written columns,
    // so editing never reassigns authorship.
    expect(lastUpdateSet).not.toBeNull();
    expect(lastUpdateSet).not.toHaveProperty('authorMemberId');
  });

  it('returns 403 for child role', async () => {
    const app = buildAppWithSeed({ callerRole: 'child' });
    const res = await app.request(`/api/notices/${N1}`, putBody({ body: 'X' }));
    expect(res.status).toBe(403);
  });

  it('returns 403 for teen role', async () => {
    const app = buildAppWithSeed({ callerRole: 'teen' });
    const res = await app.request(`/api/notices/${N1}`, putBody({ body: 'X' }));
    expect(res.status).toBe(403);
  });

  it('returns 404 when notice does not exist in this tenant', async () => {
    // updateReturn is empty: WHERE tenantId AND id matches nothing.
    const app = buildAppWithSeed({}, [], [], [], []);
    const res = await app.request(`/api/notices/${N1}`, putBody({ body: 'X' }));
    expect(res.status).toBe(404);
  });
});

describe('FHS-232: DELETE /api/notices/:id', () => {
  const N1 = '22222222-2222-4222-8222-222222222222';

  it('returns 400 for malformed UUID', async () => {
    const app = buildAppWithSeed({});
    const res = await app.request('/api/notices/not-a-uuid', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('returns 403 for child role', async () => {
    const app = buildAppWithSeed({ callerRole: 'child' });
    const res = await app.request(`/api/notices/${N1}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('returns 404 when notice does not exist in this tenant', async () => {
    const app = buildAppWithSeed({}, [], [], []);
    const res = await app.request(`/api/notices/${N1}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('returns 204 with no body when delete succeeds', async () => {
    const app = buildAppWithSeed({}, [], [], [{ id: N1 }]);
    const res = await app.request(`/api/notices/${N1}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    const text = await res.text();
    expect(text).toBe('');
  });
});
