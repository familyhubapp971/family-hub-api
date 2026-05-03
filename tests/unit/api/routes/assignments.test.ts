import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assignmentsRouter } from '../../../../apps/api/src/routes/assignments.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-231 — GET / POST / PATCH /api/assignments. DB stubbed at module
// boundary; user + tenant context seeded via tiny middleware.

const dbMock = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
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
  listRows: unknown[] = [],
  insertReturn: unknown[] = [],
  updateReturn: unknown[] = [],
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
    // 2 — On GET, the assignments list. On POST with memberId, the
    //     member-belongs-to-tenant check.
    if (selectCallIdx === 2) {
      return {
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve(listRows),
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
    values: () => ({ returning: () => Promise.resolve(insertReturn) }),
  }));

  dbMock.update.mockImplementation(() => ({
    set: () => ({ where: () => ({ returning: () => Promise.resolve(updateReturn) }) }),
  }));

  const app = new Hono();
  app.use('*', seed);
  app.route('/api/assignments', assignmentsRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
  dbMock.update.mockReset();
});

describe('FHS-231 — GET /api/assignments', () => {
  it('returns 400 when no tenant', async () => {
    const app = buildAppWithSeed({ noTenant: true });
    const res = await app.request('/api/assignments');
    expect(res.status).toBe(400);
  });

  it('returns 403 when caller is not a member', async () => {
    const app = buildAppWithSeed({ callerMissing: true });
    const res = await app.request('/api/assignments');
    expect(res.status).toBe(403);
  });

  it('returns 200 with empty list when none exist', async () => {
    const app = buildAppWithSeed({}, []);
    const res = await app.request('/api/assignments');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assignments: unknown[] };
    expect(body.assignments).toEqual([]);
  });

  it('maps doneAt to done flag', async () => {
    const A1 = '22222222-2222-4222-8222-222222222222';
    const A2 = '33333333-3333-4333-8333-333333333333';
    const doneTime = new Date('2026-05-03T10:00:00.000Z');
    const app = buildAppWithSeed({}, [
      {
        id: A1,
        title: 'Spelling',
        notes: null,
        dueDate: '2026-05-05',
        memberId: null,
        doneAt: null,
      },
      {
        id: A2,
        title: 'Read 20 mins',
        notes: null,
        dueDate: null,
        memberId: null,
        doneAt: doneTime,
      },
    ]);
    const res = await app.request('/api/assignments');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      assignments: Array<{ id: string; done: boolean; doneAt: string | null }>;
    };
    expect(body.assignments[0]).toMatchObject({ id: A1, done: false, doneAt: null });
    expect(body.assignments[1]).toMatchObject({
      id: A2,
      done: true,
      doneAt: doneTime.toISOString(),
    });
  });
});

describe('FHS-231 — POST /api/assignments', () => {
  function postBody(body: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  it('returns 403 when caller role is below adult', async () => {
    for (const callerRole of ['child', 'teen', 'guest']) {
      const app = buildAppWithSeed({ callerRole });
      const res = await app.request('/api/assignments', postBody({ title: 'X' }));
      expect(res.status, `role ${callerRole}`).toBe(403);
    }
  });

  it('returns 400 when title is empty after trim', async () => {
    const app = buildAppWithSeed({});
    const res = await app.request('/api/assignments', postBody({ title: '   ' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when dueDate is malformed', async () => {
    const app = buildAppWithSeed({});
    const res = await app.request(
      '/api/assignments',
      postBody({ title: 'Maths', dueDate: 'May 5' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when memberId is set but does not belong to the tenant', async () => {
    const app = buildAppWithSeed({ memberLookupHits: false });
    const res = await app.request(
      '/api/assignments',
      postBody({ title: 'X', memberId: '99999999-9999-4999-8999-999999999999' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 201 with the created assignment when valid', async () => {
    const A1 = '22222222-2222-4222-8222-222222222222';
    const app = buildAppWithSeed(
      {},
      [],
      [
        {
          id: A1,
          title: 'Spelling',
          notes: null,
          dueDate: '2026-05-05',
          memberId: null,
          doneAt: null,
        },
      ],
    );
    const res = await app.request(
      '/api/assignments',
      postBody({ title: 'Spelling', dueDate: '2026-05-05' }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; title: string; done: boolean };
    expect(body.id).toBe(A1);
    expect(body.title).toBe('Spelling');
    expect(body.done).toBe(false);
  });
});

describe('FHS-231 — PATCH /api/assignments/:id', () => {
  const A1 = '22222222-2222-4222-8222-222222222222';

  function patchBody(body: unknown): RequestInit {
    return {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  it('returns 400 for malformed UUID', async () => {
    const app = buildAppWithSeed({});
    const res = await app.request('/api/assignments/not-a-uuid', patchBody({ done: true }));
    expect(res.status).toBe(400);
  });

  it('returns 403 when caller role is below adult', async () => {
    const app = buildAppWithSeed({ callerRole: 'teen' });
    const res = await app.request(`/api/assignments/${A1}`, patchBody({ done: true }));
    expect(res.status).toBe(403);
  });

  it('returns 400 when body is missing done flag', async () => {
    const app = buildAppWithSeed({});
    const res = await app.request(`/api/assignments/${A1}`, patchBody({}));
    expect(res.status).toBe(400);
  });

  it('returns 404 when assignment is not in this tenant', async () => {
    const app = buildAppWithSeed({}, [], [], []);
    const res = await app.request(`/api/assignments/${A1}`, patchBody({ done: true }));
    expect(res.status).toBe(404);
  });

  it('returns 200 with done=true when toggling complete', async () => {
    const doneTime = new Date('2026-05-03T10:00:00.000Z');
    const app = buildAppWithSeed(
      {},
      [],
      [],
      [
        {
          id: A1,
          title: 'Spelling',
          notes: null,
          dueDate: null,
          memberId: null,
          doneAt: doneTime,
        },
      ],
    );
    const res = await app.request(`/api/assignments/${A1}`, patchBody({ done: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { done: boolean; doneAt: string };
    expect(body.done).toBe(true);
    expect(body.doneAt).toBe(doneTime.toISOString());
  });

  it('returns 200 with done=false when undoing', async () => {
    const app = buildAppWithSeed(
      {},
      [],
      [],
      [{ id: A1, title: 'Spelling', notes: null, dueDate: null, memberId: null, doneAt: null }],
    );
    const res = await app.request(`/api/assignments/${A1}`, patchBody({ done: false }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { done: boolean; doneAt: string | null };
    expect(body.done).toBe(false);
    expect(body.doneAt).toBeNull();
  });
});
