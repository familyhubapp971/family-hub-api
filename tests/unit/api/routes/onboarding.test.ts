import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onboardingRouter } from '../../../../apps/api/src/routes/onboarding.js';
import { habits, members, rewards } from '../../../../apps/api/src/db/schema.js';
import type { Tenant, User } from '../../../../apps/api/src/db/schema.js';

// FHS-37 — POST /api/onboarding/complete tests. Same shape as the
// FHS-91 invitations test: stub DB at the module boundary, seed user +
// tenant context via a tiny middleware, exercise the route's branches.

const dbMock = {
  select: vi.fn(),
  transaction: vi.fn(),
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

function fixedTenant(over: Partial<Tenant> = {}): Tenant {
  return {
    id: TENANT_ID,
    slug: 'khans',
    name: 'The Khan Family',
    status: 'active',
    plan: 'starter',
    timezone: 'Asia/Dubai',
    currency: 'AED',
    onboardingCompleted: false,
    createdAt: new Date('2026-05-02T00:00:00.000Z'),
    updatedAt: new Date('2026-05-02T00:00:00.000Z'),
    ...over,
  };
}

interface SeedOpts {
  noTenant?: boolean;
  callerRole?: 'admin' | 'adult' | 'teen' | 'child' | 'guest';
  callerMissing?: boolean;
  tenantState?: Tenant;
}

function buildAppWithSeed(opts: SeedOpts = {}) {
  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: USER_EMAIL, claims: {} });
    c.set('userRow', FIXED_USER);
    c.set('tenantId', opts.noTenant ? undefined : TENANT_ID);
    await next();
  };

  // The route does TWO selects: caller membership lookup + current
  // tenant lookup. Use a counter on the mock to return different
  // shapes for each call.
  let selectCallIdx = 0;
  dbMock.select.mockImplementation(() => {
    selectCallIdx += 1;
    if (selectCallIdx === 1) {
      // Caller-membership lookup.
      if (opts.callerMissing) {
        return { from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) };
      }
      return {
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([{ id: 'caller-member-id', role: opts.callerRole ?? 'admin' }]),
          }),
        }),
      };
    }
    // Second select = current tenant.
    return {
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([opts.tenantState ?? fixedTenant()]),
        }),
      }),
    };
  });

  const app = new Hono();
  app.use('*', seed);
  app.route('/api/onboarding', onboardingRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.transaction.mockReset();
});

const VALID_BODY = {
  timezone: 'Asia/Dubai',
  currency: 'AED',
  members: [
    { displayName: 'Iman', role: 'child', avatarEmoji: '👧' },
    { displayName: 'Yusuf', role: 'adult' },
  ],
};

describe('FHS-37 — POST /api/onboarding/complete', () => {
  it('returns 400 when no tenant is on the request', async () => {
    const app = buildAppWithSeed({ noTenant: true });
    const res = await app.request('/api/onboarding/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(400);
  });

  it('returns 403 when the caller is not a member of the tenant', async () => {
    const app = buildAppWithSeed({ callerMissing: true });
    const res = await app.request('/api/onboarding/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 when the caller is not an admin (only admin can finish onboarding)', async () => {
    const app = buildAppWithSeed({ callerRole: 'adult' });
    const res = await app.request('/api/onboarding/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(403);
  });

  it('returns 400 when timezone is malformed', async () => {
    const app = buildAppWithSeed();
    const res = await app.request('/api/onboarding/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_BODY, timezone: 'not a tz!' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when currency is not 3 uppercase letters', async () => {
    const app = buildAppWithSeed();
    const res = await app.request('/api/onboarding/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_BODY, currency: 'usd' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when more than 8 members are submitted', async () => {
    const app = buildAppWithSeed();
    const tooMany = Array.from({ length: 9 }, (_, i) => ({
      displayName: `m${i}`,
      role: 'adult',
    }));
    const res = await app.request('/api/onboarding/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_BODY, members: tooMany }),
    });
    expect(res.status).toBe(400);
  });

  it('is idempotent: returns 200 with the current tenant when onboarding already completed', async () => {
    const completed = fixedTenant({ onboardingCompleted: true });
    const app = buildAppWithSeed({ tenantState: completed });
    const res = await app.request('/api/onboarding/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(200);
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it('returns 200 with the updated tenant + members count on the happy path', async () => {
    const app = buildAppWithSeed();
    const updated = fixedTenant({
      onboardingCompleted: true,
      timezone: 'Asia/Dubai',
      currency: 'AED',
    });

    // Capture which TABLES the transaction inserts into rather than
    // counting calls. Catches a future reordering / new-table addition
    // with a clear assertion message instead of a "expected 3, got 4"
    // mystery. Each table maps to a returning-row count appropriate
    // for the seed shape (FHS-40: 5 habits, 3 rewards, 2 members).
    const insertedTables: unknown[] = [];
    dbMock.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        insert: (table: unknown) => {
          insertedTables.push(table);
          const rowsForTable =
            table === habits
              ? [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }, { id: 'h4' }, { id: 'h5' }]
              : table === rewards
                ? [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]
                : table === members
                  ? [{ id: 'm1' }, { id: 'm2' }]
                  : [];
          return {
            values: () => ({ returning: () => Promise.resolve(rowsForTable) }),
          };
        },
        update: () => ({
          set: () => ({ where: () => ({ returning: () => Promise.resolve([updated]) }) }),
        }),
      };
      await fn(tx);
    });

    const res = await app.request('/api/onboarding/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenant: { onboardingCompleted: boolean };
      membersAdded: number;
    };
    expect(body.tenant.onboardingCompleted).toBe(true);
    expect(body.membersAdded).toBe(2);
    // FHS-40 — assert the SET of tables touched inside the tx
    // (members + habits seed + rewards seed). Order-independent so a
    // future reorder doesn't break this test.
    expect(new Set(insertedTables)).toEqual(new Set([members, habits, rewards]));
  });
});
