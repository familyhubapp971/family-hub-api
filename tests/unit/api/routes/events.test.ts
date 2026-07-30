import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventRequestSchema, eventsRouter } from '../../../../apps/api/src/routes/events.js';
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
        type: 'school',
        location: 'Leisure Centre',
        wear: 'Swimsuit and towel',
        recurrenceDays: null,
        recurrenceEndDate: null,
      },
    ]);
    const res = await app.request('/api/events?weekStart=2026-05-04');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{
        title: string;
        startTime: string;
        type: string;
        location: string | null;
        wear: string | null;
        isRecurring: boolean;
      }>;
    };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      title: 'Swim lesson',
      startTime: '09:00',
      type: 'school',
      location: 'Leisure Centre',
      wear: 'Swimsuit and towel',
      isRecurring: false,
    });
  });

  // FHS-476 — the mocked select returns rows as-is; this confirms the GET
  // handler threads them through expandWeekOccurrences (the expansion
  // algorithm itself is covered exhaustively in
  // tests/unit/api/lib/recurrence.test.ts) and shapes the response with
  // isRecurring/seriesStartDate.
  it('expands a recurring series row into one occurrence per matching weekday (FHS-476)', async () => {
    const SERIES_ID = '44444444-4444-4444-8444-444444444444';
    // Monday 2026-05-04 anchor, repeats Tue(2) + Thu(4).
    const app = buildAppWithSeed({}, [
      {
        id: SERIES_ID,
        date: '2026-05-04',
        startTime: '16:00',
        endTime: null,
        title: 'Tennis',
        notes: null,
        memberId: null,
        type: 'home',
        location: null,
        wear: null,
        recurrenceDays: [2, 4],
        recurrenceEndDate: null,
      },
    ]);
    const res = await app.request('/api/events?weekStart=2026-05-04');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{
        id: string;
        date: string;
        isRecurring: boolean;
        seriesStartDate: string;
        recurrenceDays: number[] | null;
      }>;
    };
    expect(body.events.map((e) => e.date).sort()).toEqual(['2026-05-05', '2026-05-07']);
    expect(body.events.every((e) => e.id === SERIES_ID)).toBe(true);
    expect(body.events.every((e) => e.isRecurring)).toBe(true);
    expect(body.events.every((e) => e.seriesStartDate === '2026-05-04')).toBe(true);
    expect(body.events.every((e) => e.recurrenceDays?.join(',') === '2,4')).toBe(true);
    // The anchor's own weekday (Monday=1) isn't in [2, 4], so it never renders.
    expect(body.events.some((e) => e.date === '2026-05-04')).toBe(false);
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

  it('returns 201 with the created event when valid (type defaults to home)', async () => {
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
          type: 'home',
          location: null,
          wear: null,
          recurrenceDays: null,
          recurrenceEndDate: null,
        },
      ],
    );
    const res = await app.request(
      '/api/events',
      postBody({ date: '2026-05-04', title: 'Swim lesson', startTime: '09:00' }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      title: string;
      type: string;
      isRecurring: boolean;
      seriesStartDate: string;
    };
    expect(body.id).toBe(E1);
    expect(body.title).toBe('Swim lesson');
    expect(body.type).toBe('home');
    expect(body.isRecurring).toBe(false);
    expect(body.seriesStartDate).toBe('2026-05-04');
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });

  it('round-trips type/location/wear (FHS-265)', async () => {
    const E1 = '22222222-2222-4222-8222-222222222222';
    const app = buildAppWithSeed(
      {},
      [],
      [
        {
          id: E1,
          date: '2026-05-04',
          startTime: null,
          endTime: null,
          title: 'PE Day',
          notes: null,
          memberId: null,
          type: 'school',
          location: 'School gym',
          wear: 'PE kit',
          recurrenceDays: null,
          recurrenceEndDate: null,
        },
      ],
    );
    const res = await app.request(
      '/api/events',
      postBody({
        date: '2026-05-04',
        title: 'PE Day',
        type: 'school',
        location: 'School gym',
        wear: 'PE kit',
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      type: string;
      location: string | null;
      wear: string | null;
    };
    expect(body).toMatchObject({ type: 'school', location: 'School gym', wear: 'PE kit' });
  });

  it('rejects an unknown type with 400', async () => {
    const app = buildAppWithSeed({});
    const res = await app.request(
      '/api/events',
      postBody({ date: '2026-05-04', title: 'X', type: 'work' }),
    );
    expect(res.status).toBe(400);
  });
});

// FHS-476 — validation for the "repeat weekly" fields.
describe('FHS-476 — POST /api/events recurrence validation', () => {
  function postBody(body: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  it('creates a recurring series with recurrenceDays + recurrenceEndDate', async () => {
    const E1 = '22222222-2222-4222-8222-222222222222';
    const app = buildAppWithSeed(
      {},
      [],
      [
        {
          id: E1,
          date: '2026-05-04',
          startTime: '16:00',
          endTime: null,
          title: 'Tennis',
          notes: null,
          memberId: null,
          type: 'home',
          location: null,
          wear: null,
          recurrenceDays: [2, 4],
          recurrenceEndDate: '2026-06-30',
        },
      ],
    );
    const res = await app.request(
      '/api/events',
      postBody({
        date: '2026-05-04',
        title: 'Tennis',
        startTime: '16:00',
        recurrenceDays: [4, 2, 2], // unsorted + a duplicate
        recurrenceEndDate: '2026-06-30',
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      isRecurring: boolean;
      recurrenceDays: number[] | null;
      recurrenceEndDate: string | null;
    };
    expect(body.isRecurring).toBe(true);
    // Duplicates deduped, sorted ascending.
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });

  it('rejects a recurrenceEndDate before the event date', async () => {
    const app = buildAppWithSeed({});
    const res = await app.request(
      '/api/events',
      postBody({
        date: '2026-05-04',
        title: 'Tennis',
        recurrenceDays: [2],
        recurrenceEndDate: '2026-05-01',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a recurrenceEndDate with no recurrenceDays', async () => {
    const app = buildAppWithSeed({});
    const res = await app.request(
      '/api/events',
      postBody({ date: '2026-05-04', title: 'Tennis', recurrenceEndDate: '2026-06-30' }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects an empty recurrenceDays array', async () => {
    const app = buildAppWithSeed({});
    const res = await app.request(
      '/api/events',
      postBody({ date: '2026-05-04', title: 'Tennis', recurrenceDays: [] }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects an out-of-range weekday (7)', async () => {
    const app = buildAppWithSeed({});
    const res = await app.request(
      '/api/events',
      postBody({ date: '2026-05-04', title: 'Tennis', recurrenceDays: [7] }),
    );
    expect(res.status).toBe(400);
  });

  it('an event with recurrenceDays omitted (undefined) is a normal one-off', async () => {
    const E1 = '22222222-2222-4222-8222-222222222222';
    const app = buildAppWithSeed(
      {},
      [],
      [
        {
          id: E1,
          date: '2026-05-04',
          startTime: null,
          endTime: null,
          title: 'Dentist',
          notes: null,
          memberId: null,
          type: 'home',
          location: null,
          wear: null,
          recurrenceDays: null,
          recurrenceEndDate: null,
        },
      ],
    );
    const res = await app.request(
      '/api/events',
      postBody({ date: '2026-05-04', title: 'Dentist' }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { isRecurring: boolean };
    expect(body.isRecurring).toBe(false);
  });
});

// FHS-476 — the schema's own dedup + sort transform, tested directly
// since the route-level mock DB can't observe what gets written.
describe('createEventRequestSchema — recurrenceDays transform', () => {
  it('dedupes and sorts recurrenceDays ascending', () => {
    const parsed = createEventRequestSchema.parse({
      date: '2026-05-04',
      title: 'Tennis',
      recurrenceDays: [4, 2, 2, 4],
    });
    expect(parsed.recurrenceDays).toEqual([2, 4]);
  });

  it('leaves recurrenceDays null when omitted', () => {
    const parsed = createEventRequestSchema.parse({ date: '2026-05-04', title: 'Dentist' });
    expect(parsed.recurrenceDays).toBeNull();
  });

  it('leaves recurrenceDays null when explicitly null', () => {
    const parsed = createEventRequestSchema.parse({
      date: '2026-05-04',
      title: 'Dentist',
      recurrenceDays: null,
    });
    expect(parsed.recurrenceDays).toBeNull();
  });
});
