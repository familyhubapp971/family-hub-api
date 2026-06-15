import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readingLogRouter } from '../../../../apps/api/src/routes/reading-log.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// Learn Phase 1 — unit tests for /api/reading-log (mocked DB).
// Integration coverage (real Postgres) lives in reading-log.feature.

const dbMock = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
vi.mock('../../../../apps/api/src/db/client.js', () => ({ getDb: () => dbMock }));

const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '00000000-0000-4000-8000-000000000888';
const MEMBER_ID = '55555555-5555-4555-8555-555555555555';
const BOOK_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const FIXED_USER: User = {
  id: USER_ID,
  email: 'rl@e.com',
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
  updatedAt: new Date('2026-05-01T00:00:00.000Z'),
};

function buildApp(opts: { noTenant?: boolean; memberChecks?: unknown[][] } = {}) {
  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: 'rl@e.com', claims: {} });
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
      orderBy: () => Promise.resolve([]),
    }),
  }));
  const app = new Hono();
  app.use('*', seed);
  app.route('/api/reading-log', readingLogRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
  dbMock.update.mockReset();
  dbMock.delete.mockReset();
});

// ─── GET guards ───────────────────────────────────────────────────────────────

describe('GET /api/reading-log guards', () => {
  it('400 when no tenant context', async () => {
    const res = await buildApp({ noTenant: true }).request(
      `/api/reading-log?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(400);
  });
  it('400 when memberId missing', async () => {
    const res = await buildApp().request('/api/reading-log');
    expect(res.status).toBe(400);
  });
  it('403 when caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      `/api/reading-log?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(403);
  });
  it('403 when a teen targets another member', async () => {
    const res = await buildApp({
      memberChecks: [[{ id: 'other-id', role: 'teen' }], [{ id: MEMBER_ID }]],
    }).request(`/api/reading-log?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(403);
  });
});

// ─── POST guards ──────────────────────────────────────────────────────────────

describe('POST /api/reading-log guards', () => {
  function post(body: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  it('400 when title is missing', async () => {
    const res = await buildApp().request('/api/reading-log', post({ memberId: MEMBER_ID }));
    expect(res.status).toBe(400);
  });

  it('400 when title exceeds 200 chars', async () => {
    const res = await buildApp().request(
      '/api/reading-log',
      post({ memberId: MEMBER_ID, title: 'x'.repeat(201) }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when author exceeds 120 chars', async () => {
    const res = await buildApp().request(
      '/api/reading-log',
      post({ memberId: MEMBER_ID, title: 'A Book', author: 'y'.repeat(121) }),
    );
    expect(res.status).toBe(400);
  });

  it('403 when caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      '/api/reading-log',
      post({ memberId: MEMBER_ID, title: 'A Book' }),
    );
    expect(res.status).toBe(403);
  });

  it('201 and returns the created book', async () => {
    const now = new Date('2026-06-16T10:00:00.000Z');
    const returnedBook = {
      id: BOOK_ID,
      title: 'Matilda',
      author: 'Roald Dahl',
      finished: false,
      createdAt: now,
      updatedAt: now,
    };
    // loadCaller → admin, memberInTenant → found (use memberChecks queue)
    const app = buildApp({
      memberChecks: [[{ id: MEMBER_ID, role: 'admin' }], [{ id: MEMBER_ID }]],
    });
    dbMock.insert.mockImplementation(() => ({
      values: () => ({ returning: () => Promise.resolve([returnedBook]) }),
    }));
    const res = await app.request(
      '/api/reading-log',
      post({ memberId: MEMBER_ID, title: 'Matilda', author: 'Roald Dahl' }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { title: string; finished: boolean };
    expect(body.title).toBe('Matilda');
    expect(body.finished).toBe(false);
  });
});

// ─── PATCH guards ─────────────────────────────────────────────────────────────

describe('PATCH /api/reading-log/:id guards', () => {
  function patch(body: unknown): RequestInit {
    return {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }
  it('400 when finished is missing', async () => {
    const res = await buildApp().request(
      `/api/reading-log/${BOOK_ID}`,
      patch({ memberId: MEMBER_ID }),
    );
    expect(res.status).toBe(400);
  });
  it('403 when caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      `/api/reading-log/${BOOK_ID}`,
      patch({ memberId: MEMBER_ID, finished: true }),
    );
    expect(res.status).toBe(403);
  });
});

// ─── DELETE guards ────────────────────────────────────────────────────────────

describe('DELETE /api/reading-log/:id guards', () => {
  it('400 when memberId missing', async () => {
    const res = await buildApp().request(`/api/reading-log/${BOOK_ID}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
  });
  it('403 when caller is not a member', async () => {
    const res = await buildApp({ memberChecks: [[]] }).request(
      `/api/reading-log/${BOOK_ID}?memberId=${MEMBER_ID}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(403);
  });
});
