import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { journalRouter } from '../../../../apps/api/src/routes/journal.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-270: per-day journal unit tests (mocked DB).
// DB-backed behaviour + member-scoping covered by journal.feature integration tests.

// ─── DB mock ─────────────────────────────────────────────────────────────────

const dbMock = { select: vi.fn(), insert: vi.fn() };
vi.mock('../../../../apps/api/src/db/client.js', () => ({ getDb: () => dbMock }));

// ─── Constants ────────────────────────────────────────────────────────────────

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const MEMBER_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_MEMBER_ID = '55555555-5555-4555-8555-555555555555';
const TEST_DATE = '2026-06-15';

const FIXED_USER: User = {
  id: USER_ID,
  email: 's@e.com',
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
  updatedAt: new Date('2026-05-01T00:00:00.000Z'),
};

// A fully-populated DB row shape for the per-day model.
const SAMPLE_ROW = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  tenantId: TENANT_ID,
  memberId: MEMBER_ID,
  entryDate: TEST_DATE,
  mood: 'happy' as const,
  gratitude1: 'sunny day',
  gratitude2: null,
  gratitude3: null,
  quoteIndex: 0,
  creativity: { '0': 'flying' },
  body: 'great day',
  createdAt: new Date('2026-06-15T10:00:00.000Z'),
  updatedAt: new Date('2026-06-15T10:00:00.000Z'),
};

// ─── App factory ─────────────────────────────────────────────────────────────

/**
 * memberChecks: queue of arrays returned by the mock DB for each
 * `.select()...limit()` call, in order:
 *   [0] = loadCaller result (empty [] → 403 "caller not member")
 *   [1] = memberInTenant result (empty [] → 404)
 * After those two gates the router does its real DB query (select/insert).
 */
function buildApp(
  opts: {
    noTenant?: boolean;
    memberChecks?: unknown[][];
  } = {},
) {
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
        orderBy: () => Promise.resolve([]),
      }),
      // for /earliest: select({ earliest: min(...) }).from(...).where(...)
    }),
  }));

  const app = new Hono();
  app.use('*', seed);
  app.route('/api/journal', journalRouter);
  return app;
}

function put(body: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
});

// ─── GET /content ─────────────────────────────────────────────────────────────

describe('GET /api/journal/content', () => {
  it('400 when no tenant', async () => {
    const res = await buildApp({ noTenant: true }).request('/api/journal/content');
    expect(res.status).toBe(400);
  });

  it('200 with quotes / creativityQuestions / moods arrays', async () => {
    const res = await buildApp().request('/api/journal/content');
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      quotes: unknown[];
      creativityQuestions: unknown[];
      moods: unknown[];
    };
    expect(json.quotes).toHaveLength(5);
    expect(json.creativityQuestions).toHaveLength(6);
    expect(json.moods).toHaveLength(8);
  });
});

// ─── GET /?memberId=&date= (day view) ─────────────────────────────────────────

describe('GET /api/journal (day view) guards', () => {
  it('400 when no tenant', async () => {
    const res = await buildApp({ noTenant: true }).request(
      `/api/journal?memberId=${MEMBER_ID}&date=${TEST_DATE}`,
    );
    expect(res.status).toBe(400);
  });

  it('400 when date is missing', async () => {
    const res = await buildApp().request(`/api/journal?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(400);
  });

  it('400 when date format is wrong', async () => {
    const res = await buildApp().request(`/api/journal?memberId=${MEMBER_ID}&date=15-06-2026`);
    expect(res.status).toBe(400);
  });

  it('400 when memberId is missing', async () => {
    const res = await buildApp().request(`/api/journal?date=${TEST_DATE}`);
    expect(res.status).toBe(400);
  });

  it('403 when the caller is not a member of this tenant', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      `/api/journal?memberId=${MEMBER_ID}&date=${TEST_DATE}`,
    );
    expect(res.status).toBe(403);
  });

  it('404 when the target member is not in the tenant', async () => {
    const res = await buildApp({
      memberChecks: [[{ id: 'caller', role: 'admin' }], []],
    }).request(`/api/journal?memberId=${MEMBER_ID}&date=${TEST_DATE}`);
    expect(res.status).toBe(404);
  });

  it('403 when a non-parent child caller targets another member', async () => {
    const res = await buildApp({
      memberChecks: [[{ id: OTHER_MEMBER_ID, role: 'child' }], [{ id: MEMBER_ID }]],
    }).request(`/api/journal?memberId=${MEMBER_ID}&date=${TEST_DATE}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/journal (day view): happy path', () => {
  it('returns null entry + quoteIndex when no row exists', async () => {
    // loadCaller → admin, memberInTenant → found, day query → empty
    const queue = [
      [{ id: 'caller', role: 'admin' }],
      [{ id: MEMBER_ID }],
      [], // no entry for that date
    ];
    const app = buildApp({ memberChecks: [] });

    let callCount = 0;
    dbMock.select.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(queue[callCount++] ?? []),
          orderBy: () => Promise.resolve([]),
        }),
      }),
    }));

    const res = await app.request(`/api/journal?memberId=${MEMBER_ID}&date=${TEST_DATE}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { entry: null; quoteIndex: number };
    expect(json.entry).toBeNull();
    expect(typeof json.quoteIndex).toBe('number');
  });

  it('returns populated entry when row exists', async () => {
    const queue = [[{ id: 'caller', role: 'admin' }], [{ id: MEMBER_ID }], [SAMPLE_ROW]];
    const app = buildApp({ memberChecks: [] });
    let callCount = 0;
    dbMock.select.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(queue[callCount++] ?? []),
          orderBy: () => Promise.resolve([]),
        }),
      }),
    }));

    const res = await app.request(`/api/journal?memberId=${MEMBER_ID}&date=${TEST_DATE}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      entry: { mood: string; body: string };
      quoteIndex: number;
    };
    expect(json.entry?.mood).toBe('happy');
    expect(json.entry?.body).toBe('great day');
    expect(typeof json.quoteIndex).toBe('number');
  });
});

// ─── GET /entries ─────────────────────────────────────────────────────────────

describe('GET /api/journal/entries guards', () => {
  it('403 when caller not in tenant', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      `/api/journal/entries?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(403);
  });

  it('404 when member not in tenant', async () => {
    const res = await buildApp({
      memberChecks: [[{ id: 'caller', role: 'admin' }], []],
    }).request(`/api/journal/entries?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(404);
  });
});

// ─── GET /earliest ────────────────────────────────────────────────────────────

describe('GET /api/journal/earliest guards', () => {
  it('400 when memberId missing', async () => {
    const res = await buildApp().request('/api/journal/earliest');
    expect(res.status).toBe(400);
  });

  it('403 when caller not in tenant', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      `/api/journal/earliest?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(403);
  });
});

// ─── PUT / ────────────────────────────────────────────────────────────────────

describe('PUT /api/journal guards', () => {
  it('400 when no tenant', async () => {
    const res = await buildApp({ noTenant: true }).request(
      '/api/journal',
      put({ memberId: MEMBER_ID, entryDate: TEST_DATE }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when entryDate is missing', async () => {
    const res = await buildApp().request('/api/journal', put({ memberId: MEMBER_ID }));
    expect(res.status).toBe(400);
  });

  it('400 when entryDate format is wrong', async () => {
    const res = await buildApp().request(
      '/api/journal',
      put({ memberId: MEMBER_ID, entryDate: '15/06/2026' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when entryDate is not a real calendar date (FHS-323)', async () => {
    const res = await buildApp().request(
      '/api/journal',
      put({ memberId: MEMBER_ID, entryDate: '2026-02-30' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when entryDate is in the future (FHS-323)', async () => {
    const res = await buildApp().request(
      '/api/journal',
      put({ memberId: MEMBER_ID, entryDate: '2099-12-31' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when mood value is invalid', async () => {
    const res = await buildApp().request(
      '/api/journal',
      put({ memberId: MEMBER_ID, entryDate: TEST_DATE, mood: 'ecstatic' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when body exceeds 5000 chars', async () => {
    const res = await buildApp().request(
      '/api/journal',
      put({ memberId: MEMBER_ID, entryDate: TEST_DATE, body: 'x'.repeat(5001) }),
    );
    expect(res.status).toBe(400);
  });

  it('403 when caller is not a member of this tenant', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      '/api/journal',
      put({ memberId: MEMBER_ID, entryDate: TEST_DATE }),
    );
    expect(res.status).toBe(403);
  });

  it('404 when target member not in tenant', async () => {
    const res = await buildApp({
      memberChecks: [[{ id: 'caller', role: 'admin' }], []],
    }).request('/api/journal', put({ memberId: MEMBER_ID, entryDate: TEST_DATE }));
    expect(res.status).toBe(404);
  });

  it('403 when a child caller targets another member', async () => {
    const res = await buildApp({
      memberChecks: [[{ id: OTHER_MEMBER_ID, role: 'child' }], [{ id: MEMBER_ID }]],
    }).request('/api/journal', put({ memberId: MEMBER_ID, entryDate: TEST_DATE }));
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/journal: happy path', () => {
  it('200 with the saved entry including computed quoteIndex', async () => {
    const queue = [[{ id: 'caller', role: 'admin' }], [{ id: MEMBER_ID }]];
    const app = buildApp({ memberChecks: [] });
    let selectCount = 0;
    dbMock.select.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(queue[selectCount++] ?? []),
        }),
      }),
    }));
    dbMock.insert.mockImplementation(() => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: () => Promise.resolve([SAMPLE_ROW]),
        }),
      }),
    }));

    const res = await app.request(
      '/api/journal',
      put({
        memberId: MEMBER_ID,
        entryDate: TEST_DATE,
        mood: 'happy',
        gratitude1: 'sunny day',
        body: 'great day',
        creativity: { '0': 'flying' },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      mood: string;
      quoteIndex: number;
      creativity: Record<string, string>;
    };
    expect(json.mood).toBe('happy');
    expect(typeof json.quoteIndex).toBe('number');
    expect(json.creativity?.['0']).toBe('flying');
  });
});
