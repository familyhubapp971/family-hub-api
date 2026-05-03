import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { membersRouter } from '../../../../apps/api/src/routes/members.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-108 — GET /api/members. Stub the DB at the module boundary;
// seed user + tenant context via a tiny middleware. Same shape as the
// onboarding/invitations route tests.

const dbMock = { select: vi.fn() };
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
}

function buildAppWithSeed(opts: SeedOpts = {}, members: unknown[] = []) {
  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: USER_EMAIL, claims: {} });
    c.set('userRow', FIXED_USER);
    c.set('tenantId', opts.noTenant ? undefined : TENANT_ID);
    await next();
  };

  // Two selects: caller-membership lookup + members list.
  let selectCallIdx = 0;
  dbMock.select.mockImplementation(() => {
    selectCallIdx += 1;
    if (selectCallIdx === 1) {
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(opts.callerMissing ? [] : [{ id: 'caller-member-id' }]),
          }),
        }),
      };
    }
    return {
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(members),
        }),
      }),
    };
  });

  const app = new Hono();
  app.use('*', seed);
  app.route('/api/members', membersRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
});

describe('FHS-108 — GET /api/members', () => {
  it('returns 400 when no tenant is on the request', async () => {
    const app = buildAppWithSeed({ noTenant: true });
    const res = await app.request('/api/members');
    expect(res.status).toBe(400);
  });

  it('returns 403 when the caller is not a member of the tenant', async () => {
    const app = buildAppWithSeed({ callerMissing: true });
    const res = await app.request('/api/members');
    expect(res.status).toBe(403);
  });

  it('returns 200 with an empty list when the tenant has no members', async () => {
    const app = buildAppWithSeed({}, []);
    const res = await app.request('/api/members');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: unknown[] };
    expect(body.members).toEqual([]);
  });

  it('derives status=active when user_id is set, status=unclaimed otherwise', async () => {
    const baseDate = new Date('2026-05-02T00:00:00.000Z');
    const M1 = '22222222-2222-4222-8222-222222222222';
    const M2 = '33333333-3333-4333-8333-333333333333';
    const app = buildAppWithSeed({}, [
      {
        id: M1,
        displayName: 'Sarah',
        role: 'admin',
        avatarEmoji: '👩',
        userId: USER_ID,
        createdAt: baseDate,
      },
      {
        id: M2,
        displayName: 'Iman',
        role: 'child',
        avatarEmoji: '👧',
        userId: null,
        createdAt: baseDate,
      },
    ]);
    const res = await app.request('/api/members');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: Array<{ id: string; status: string; role: string; avatarEmoji: string | null }>;
    };
    expect(body.members).toHaveLength(2);
    expect(body.members[0]).toMatchObject({
      id: M1,
      role: 'admin',
      status: 'active',
      avatarEmoji: '👩',
    });
    expect(body.members[1]).toMatchObject({
      id: M2,
      role: 'child',
      status: 'unclaimed',
      avatarEmoji: '👧',
    });
  });
});
