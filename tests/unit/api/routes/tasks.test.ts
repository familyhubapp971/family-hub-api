import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tasksRouter } from '../../../../apps/api/src/routes/tasks.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-233 — GET / POST / PATCH / DELETE /api/tasks. Per-member private
// to-do list — no role gate (kids can create + toggle + delete their
// own tasks), but every WHERE includes member_id == caller.id.

const dbMock = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
vi.mock('../../../../apps/api/src/db/client.js', () => ({
  getDb: () => dbMock,
}));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const CALLER_MEMBER_ID = '44444444-4444-4444-8444-444444444444';
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
}

function buildAppWithSeed(
  opts: SeedOpts = {},
  listRows: unknown[] = [],
  insertReturn: unknown[] = [],
  updateReturn: unknown[] = [],
  deleteReturn: unknown[] = [],
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
            limit: () => Promise.resolve(opts.callerMissing ? [] : [{ id: CALLER_MEMBER_ID }]),
          }),
        }),
      };
    }
    return {
      from: () => ({
        where: () => ({ orderBy: () => Promise.resolve(listRows) }),
      }),
    };
  });

  dbMock.insert.mockImplementation(() => ({
    values: () => ({ returning: () => Promise.resolve(insertReturn) }),
  }));
  dbMock.update.mockImplementation(() => ({
    set: () => ({ where: () => ({ returning: () => Promise.resolve(updateReturn) }) }),
  }));
  dbMock.delete.mockImplementation(() => ({
    where: () => ({ returning: () => Promise.resolve(deleteReturn) }),
  }));

  const app = new Hono();
  app.use('*', seed);
  app.route('/api/tasks', tasksRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
  dbMock.update.mockReset();
  dbMock.delete.mockReset();
});

describe('FHS-233 — GET /api/tasks', () => {
  it('returns 400 when no tenant', async () => {
    const res = await buildAppWithSeed({ noTenant: true }).request('/api/tasks');
    expect(res.status).toBe(400);
  });

  it('returns 403 when caller is not a member', async () => {
    const res = await buildAppWithSeed({ callerMissing: true }).request('/api/tasks');
    expect(res.status).toBe(403);
  });

  it('returns 200 with empty list when none exist', async () => {
    const res = await buildAppWithSeed({}, []).request('/api/tasks');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: unknown[] };
    expect(body.tasks).toEqual([]);
  });

  it('maps doneAt to done flag', async () => {
    const T1 = '22222222-2222-4222-8222-222222222222';
    const T2 = '33333333-3333-4333-8333-333333333333';
    const doneTime = new Date('2026-05-03T10:00:00.000Z');
    const res = await buildAppWithSeed({}, [
      { id: T1, title: 'Buy milk', dueDate: '2026-05-05', doneAt: null },
      { id: T2, title: 'Email school', dueDate: null, doneAt: doneTime },
    ]).request('/api/tasks');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tasks: Array<{ id: string; done: boolean; doneAt: string | null }>;
    };
    expect(body.tasks[0]).toMatchObject({ id: T1, done: false, doneAt: null });
    expect(body.tasks[1]).toMatchObject({
      id: T2,
      done: true,
      doneAt: doneTime.toISOString(),
    });
  });
});

describe('FHS-233 — POST /api/tasks', () => {
  function postBody(body: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  it('returns 400 when title is empty after trim', async () => {
    const res = await buildAppWithSeed({}).request('/api/tasks', postBody({ title: '   ' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when dueDate is malformed', async () => {
    const res = await buildAppWithSeed({}).request(
      '/api/tasks',
      postBody({ title: 'X', dueDate: 'tomorrow' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 201 with the created task (no role gate)', async () => {
    const T1 = '22222222-2222-4222-8222-222222222222';
    const res = await buildAppWithSeed(
      {},
      [],
      [{ id: T1, title: 'Buy milk', dueDate: null, doneAt: null }],
    ).request('/api/tasks', postBody({ title: 'Buy milk' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; done: boolean };
    expect(body.id).toBe(T1);
    expect(body.done).toBe(false);
  });
});

describe('FHS-233 — PATCH /api/tasks/:id', () => {
  const T1 = '22222222-2222-4222-8222-222222222222';
  function patchBody(body: unknown): RequestInit {
    return {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  it('returns 400 for malformed UUID', async () => {
    const res = await buildAppWithSeed({}).request(
      '/api/tasks/not-a-uuid',
      patchBody({ done: true }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when task does not belong to the caller', async () => {
    const res = await buildAppWithSeed({}, [], [], []).request(
      `/api/tasks/${T1}`,
      patchBody({ done: true }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 200 with done=true when toggling complete', async () => {
    const doneTime = new Date('2026-05-03T10:00:00.000Z');
    const res = await buildAppWithSeed(
      {},
      [],
      [],
      [{ id: T1, title: 'Buy milk', dueDate: null, doneAt: doneTime }],
    ).request(`/api/tasks/${T1}`, patchBody({ done: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { done: boolean; doneAt: string };
    expect(body.done).toBe(true);
  });
});

describe('FHS-233 — DELETE /api/tasks/:id', () => {
  const T1 = '22222222-2222-4222-8222-222222222222';

  it('returns 404 when task does not belong to the caller', async () => {
    const res = await buildAppWithSeed({}, [], [], [], []).request(`/api/tasks/${T1}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });

  it('returns 204 when delete succeeds', async () => {
    const res = await buildAppWithSeed({}, [], [], [], [{ id: T1 }]).request(`/api/tasks/${T1}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });
});
