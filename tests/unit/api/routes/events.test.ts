import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eventsRouter } from '../../../../apps/api/src/routes/events.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-230 — GET + POST /api/events. Same shape as the meals route
// test: stub db at module boundary; seed user + tenant context via a
// tiny middleware. POST exercises validation + role-gate + member
// ownership check.

const dbMock = {
  select: vi.fn(),
  insert: vi.fn(),
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
  memberLookupHits?: boolean;
}

function buildAppWithSeed(
  opts: SeedOpts = {},
  events: unknown[] = [],
  insertReturn: unknown[] = [],
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
    // 1 — caller-membership lookup
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
    // 2 — On GET this is the events list. On POST with memberId set it's
    //     the member-belongs-to-tenant check; on POST without memberId
    //     it's never called.
    if (selectCallIdx === 2) {
      return {
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve(events),
            limit: () => Promise.resolve(opts.memberLookupHits ? [{ id: 'm-1' }] : []),
          }),
        }),
      };
    }
    return {
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve([]),
          limit: () => Promise.resolve([]),
        }),
      }),
    };
  });

  dbMock.insert.mockImplementation(() => ({
    values: () => ({
      returning: () => Promise.resolve(insertReturn),
    }),
  }));

  const app = new Hono();
  app.use('*', seed);
  app.route('/api/events', eventsRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
});

describe('FHS-230 — GET /api/events', () => {
  it('returns 400 when no tenant is on the request', async () => {
    const app = buildAppWithSeed({ noTenant: true });
    const res = await app.request('/api/events?weekStart=2026-05-04');
    expect(res.status).toBe(400);
  });

  it('returns 400 when weekStart is missing', async () => {
    const app = buildAppWithSeed({});
    const res = await app.request('/api/events');
    expect(res.status).toBe(400);
  });

  it('returns 400 when weekStart is malformed', async () => {
    const app = buildAppWithSeed({});
    const res = await app.request('/api/events?weekStart=2026-5-4');
    expect(res.status).toBe(400);
  });

  it('returns 403 when caller is not a member of the tenant', async () => {
    const app = buildAppWithSeed({ callerMissing: true });
    const res = await app.request('/api/events?weekStart=2026-05-04');
    expect(res.status).toBe(403);
  });

  it('returns 200 with empty events when none in the window', async () => {
    const app = buildAppWithSeed({}, []);
    const res = await app.request('/api/events?weekStart=2026-05-04');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { weekStart: string; events: unknown[] };
    expect(body.weekStart).toBe('2026-05-04');
    expect(body.events).toEqual([]);
  });

  it('returns events ordered by date + start_time', async () => {
    const E1 = '22222222-2222-4222-8222-222222222222';
    const app = buildAppWithSeed({}, [
      {
        id: E1,
        date: '2026-05-04',
        startTime: '09:00',
        endTime: '10:00',
        title: 'Swim lesson',
        notes: null,
        memberId: null,
      },
    ]);
    const res = await app.request('/api/events?weekStart=2026-05-04');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ title: string; startTime: string }> };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      title: 'Swim lesson',
      startTime: '09:00',
    });
  });
});

describe('FHS-230 — POST /api/events', () => {
  function postBody(body: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  it('returns 400 when no tenant is on the request', async () => {
    const app = buildAppWithSeed({ noTenant: true });
    const res = await app.request('/api/events', postBody({ date: '2026-05-04', title: 'X' }));
    expect(res.status).toBe(400);
  });

  it('returns 403 when caller has no membership', async () => {
    const app = buildAppWithSeed({ callerMissing: true });
    const res = await app.request('/api/events', postBody({ date: '2026-05-04', title: 'X' }));
    expect(res.status).toBe(403);
  });

  it('returns 403 when caller is a child', async () => {
    const app = buildAppWithSeed({ callerRole: 'child' });
    const res = await app.request('/api/events', postBody({ date: '2026-05-04', title: 'X' }));
    expect(res.status).toBe(403);
  });

  it('returns 403 for teen and guest roles', async () => {
    for (const callerRole of ['teen', 'guest']) {
      const app = buildAppWithSeed({ callerRole });
      const res = await app.request('/api/events', postBody({ date: '2026-05-04', title: 'X' }));
      expect(res.status, `role ${callerRole}`).toBe(403);
    }
  });

  it('returns 400 when date is malformed', async () => {
    const app = buildAppWithSeed({});
    const res = await app.request('/api/events', postBody({ date: 'May 4', title: 'X' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when endTime is set without startTime', async () => {
    const app = buildAppWithSeed({});
    const res = await app.request(
      '/api/events',
      postBody({ date: '2026-05-04', title: 'Pickup', endTime: '17:00' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when endTime is before startTime', async () => {
    const app = buildAppWithSeed({});
    const res = await app.request(
      '/api/events',
      postBody({
        date: '2026-05-04',
        title: 'Backwards meeting',
        startTime: '10:00',
        endTime: '09:00',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when title is empty after trim', async () => {
    const app = buildAppWithSeed({});
    const res = await app.request('/api/events', postBody({ date: '2026-05-04', title: '   ' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when memberId is set but does not belong to the tenant', async () => {
    const app = buildAppWithSeed({ memberLookupHits: false });
    const res = await app.request(
      '/api/events',
      postBody({
        date: '2026-05-04',
        title: 'X',
        memberId: '33333333-3333-4333-8333-333333333333',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 201 with the created event when valid', async () => {
    const E1 = '22222222-2222-4222-8222-222222222222';
    const app = buildAppWithSeed(
      {},
      [],
      [
        {
          id: E1,
          date: '2026-05-04',
          startTime: '09:00',
          endTime: null,
          title: 'Swim lesson',
          notes: null,
          memberId: null,
        },
      ],
    );
    const res = await app.request(
      '/api/events',
      postBody({ date: '2026-05-04', title: 'Swim lesson', startTime: '09:00' }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; title: string };
    expect(body.id).toBe(E1);
    expect(body.title).toBe('Swim lesson');
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });
});
