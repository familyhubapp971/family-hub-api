import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { worldFlagsRouter } from '../../../../apps/api/src/routes/world-flags.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// Learn Phase 2a — unit tests for /api/world-flags (mocked DB).
// Integration coverage (real Postgres) lives in world-flags.feature.

const dbMock = {
  select: vi.fn(),
  insert: vi.fn(),
};
vi.mock('../../../../apps/api/src/db/client.js', () => ({ getDb: () => dbMock }));

const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '00000000-0000-4000-8000-000000000999';
const MEMBER_ID = '55555555-5555-4555-8555-555555555556';

const FIXED_USER: User = {
  id: USER_ID,
  email: 'wf@e.com',
  createdAt: new Date('2026-06-16T00:00:00.000Z'),
  updatedAt: new Date('2026-06-16T00:00:00.000Z'),
};

function buildApp(
  opts: {
    noTenant?: boolean;
    // selectQueue: each shift() call returns the next mocked select result
    selectQueue?: unknown[][];
  } = {},
) {
  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: 'wf@e.com', claims: {} });
    c.set('userRow', FIXED_USER);
    c.set('tenantId', opts.noTenant ? undefined : TENANT_ID);
    await next();
  };
  const queue = [...(opts.selectQueue ?? [])];
  dbMock.select.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(queue.shift() ?? []),
      }),
    }),
  }));
  const app = new Hono();
  app.use('*', seed);
  app.route('/api/world-flags', worldFlagsRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
});

// ─── GET guards ───────────────────────────────────────────────────────────────

describe('GET /api/world-flags guards', () => {
  it('400 when no tenant context', async () => {
    const res = await buildApp({ noTenant: true }).request(
      `/api/world-flags?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(400);
  });

  it('400 when memberId missing', async () => {
    const res = await buildApp().request('/api/world-flags');
    expect(res.status).toBe(400);
  });

  it('400 when memberId is not a UUID', async () => {
    const res = await buildApp().request('/api/world-flags?memberId=not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('403 when caller is not a member of the tenant', async () => {
    // loadCaller returns empty → caller not found → 403
    const res = await buildApp({ selectQueue: [[]] }).request(
      `/api/world-flags?memberId=${MEMBER_ID}`,
    );
    expect(res.status).toBe(403);
  });

  it('403 when a child tries to access another member', async () => {
    // loadCaller returns a child with a different id
    const res = await buildApp({
      selectQueue: [[{ id: 'other-id', role: 'child' }], [{ id: MEMBER_ID }]],
    }).request(`/api/world-flags?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(403);
  });

  it('404 when target member not in tenant', async () => {
    // loadCaller = admin, memberInTenant = empty
    const res = await buildApp({
      selectQueue: [[{ id: MEMBER_ID, role: 'admin' }], []],
    }).request(`/api/world-flags?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(404);
  });

  it('200 and returns explored codes for admin caller', async () => {
    // loadCaller = admin, memberInTenant = found, then explored rows
    dbMock.select
      // loadCaller
      .mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([{ id: MEMBER_ID, role: 'admin' }]) }),
        }),
      }))
      // memberInTenant
      .mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([{ id: MEMBER_ID }]) }),
        }),
      }))
      // explored rows query (no .limit, uses .where directly)
      .mockImplementationOnce(() => ({
        from: () => ({
          where: () => Promise.resolve([{ countryCode: 'GB' }, { countryCode: 'US' }]),
        }),
      }));

    const res = await buildApp().request(`/api/world-flags?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { explored: string[] };
    expect(body.explored).toContain('GB');
    expect(body.explored).toContain('US');
  });

  it('200 with empty list when member has no explored flags', async () => {
    dbMock.select
      .mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([{ id: MEMBER_ID, role: 'admin' }]) }),
        }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([{ id: MEMBER_ID }]) }),
        }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => Promise.resolve([]) }),
      }));

    const res = await buildApp().request(`/api/world-flags?memberId=${MEMBER_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { explored: string[] };
    expect(body.explored).toHaveLength(0);
  });
});

// ─── POST /explore guards ─────────────────────────────────────────────────────

describe('POST /api/world-flags/explore guards', () => {
  function post(body: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  it('400 when no tenant context', async () => {
    const res = await buildApp({ noTenant: true }).request(
      '/api/world-flags/explore',
      post({ memberId: MEMBER_ID, countryCode: 'GB' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when memberId is missing', async () => {
    const res = await buildApp().request('/api/world-flags/explore', post({ countryCode: 'GB' }));
    expect(res.status).toBe(400);
  });

  it('400 when countryCode is too short', async () => {
    const res = await buildApp().request(
      '/api/world-flags/explore',
      post({ memberId: MEMBER_ID, countryCode: 'G' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when countryCode is too long', async () => {
    const res = await buildApp().request(
      '/api/world-flags/explore',
      post({ memberId: MEMBER_ID, countryCode: 'GBXX' }),
    );
    expect(res.status).toBe(400);
  });

  it('403 when caller is not a member', async () => {
    const res = await buildApp({ selectQueue: [[]] }).request(
      '/api/world-flags/explore',
      post({ memberId: MEMBER_ID, countryCode: 'GB' }),
    );
    expect(res.status).toBe(403);
  });

  it('403 when a child caller targets another member', async () => {
    const res = await buildApp({
      selectQueue: [[{ id: 'other-id', role: 'child' }], [{ id: MEMBER_ID }]],
    }).request('/api/world-flags/explore', post({ memberId: MEMBER_ID, countryCode: 'GB' }));
    expect(res.status).toBe(403);
  });

  it('404 when target member not in tenant', async () => {
    const res = await buildApp({
      selectQueue: [[{ id: MEMBER_ID, role: 'admin' }], []],
    }).request('/api/world-flags/explore', post({ memberId: MEMBER_ID, countryCode: 'GB' }));
    expect(res.status).toBe(404);
  });

  it('200 and returns { explored: true } on success', async () => {
    dbMock.select
      .mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([{ id: MEMBER_ID, role: 'admin' }]) }),
        }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([{ id: MEMBER_ID }]) }),
        }),
      }));
    dbMock.insert.mockImplementation(() => ({
      values: () => ({ onConflictDoNothing: () => Promise.resolve(undefined) }),
    }));

    const res = await buildApp().request(
      '/api/world-flags/explore',
      post({ memberId: MEMBER_ID, countryCode: 'GB' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { explored: boolean };
    expect(body.explored).toBe(true);
  });

  it('200 (idempotent) when posting same code twice — onConflictDoNothing', async () => {
    // Both calls go through; the DB deduplication is handled by onConflictDoNothing
    // at the Postgres level. In the unit test we just verify a 200 comes back both times.
    for (let i = 0; i < 2; i++) {
      dbMock.select
        .mockImplementationOnce(() => ({
          from: () => ({
            where: () => ({ limit: () => Promise.resolve([{ id: MEMBER_ID, role: 'admin' }]) }),
          }),
        }))
        .mockImplementationOnce(() => ({
          from: () => ({
            where: () => ({ limit: () => Promise.resolve([{ id: MEMBER_ID }]) }),
          }),
        }));
      dbMock.insert.mockImplementation(() => ({
        values: () => ({ onConflictDoNothing: () => Promise.resolve(undefined) }),
      }));
      const res = await buildApp().request(
        '/api/world-flags/explore',
        post({ memberId: MEMBER_ID, countryCode: 'GB' }),
      );
      expect(res.status).toBe(200);
    }
    // Verify insert was called both times (idempotency is Postgres-side)
    expect(dbMock.insert).toHaveBeenCalledTimes(2);
  });
});
