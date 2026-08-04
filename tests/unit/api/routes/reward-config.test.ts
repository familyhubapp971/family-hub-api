import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rewardConfigRouter } from '../../../../apps/api/src/routes/reward-config.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-512: GET is readable by any family member; PUT (changing the family
// rate or a kid's override) is admin-only. Both are tenant-scoped: a caller
// can only ever read/write their OWN family's config.

const dbMock = { select: vi.fn(), update: vi.fn() };
vi.mock('../../../../apps/api/src/db/client.js', () => ({ getDb: () => dbMock }));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const KID_ID = '44444444-4444-4444-8444-444444444444';
const KID_2_ID = '55555555-5555-4555-8555-555555555555';
const FIXED_USER: User = {
  id: USER_ID,
  email: 's@e.com',
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: new Date('2026-06-01T00:00:00.000Z'),
};

function chain(rows: unknown): unknown {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    limit: () => obj,
    orderBy: () => obj,
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return obj;
}

interface SeedOpts {
  callerRole: string | null;
  tenantRow?: { currency: string; stickerRateMinor: number } | null;
  kidRows?: Array<{
    id: string;
    displayName: string;
    avatarEmoji: string | null;
    stickerRateMinor: number | null;
  }>;
}

function buildApp(opts: SeedOpts) {
  const { callerRole, tenantRow = { currency: 'AED', stickerRateMinor: 50 }, kidRows = [] } = opts;
  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: 's@e.com', claims: {} });
    c.set('userRow', FIXED_USER);
    c.set('tenantId', TENANT_ID);
    await next();
  };

  // Call order for GET (loadConfig): 1 = loadCaller (guardTenant), then
  // Promise.all([tenant row, kid rows]) = 2 and 3 (order not guaranteed by
  // Promise.all, but our mock just serves each select() call sequentially,
  // both queries are independent so index order is deterministic here).
  let idx = 0;
  dbMock.select.mockImplementation(() => {
    idx += 1;
    if (idx === 1) {
      return chain(callerRole ? [{ id: 'm1', role: callerRole }] : []);
    }
    if (idx === 2) return chain(tenantRow ? [tenantRow] : []);
    return chain(kidRows);
  });

  const app = new Hono();
  app.use('*', seed);
  app.route('/api/reward-config', rewardConfigRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.update.mockReset();
});

describe('GET /api/reward-config', () => {
  it('403 when the caller is not a member of this tenant', async () => {
    const res = await buildApp({ callerRole: null }).request('/api/reward-config');
    expect(res.status).toBe(403);
  });

  it('200 for any member (not just admin): read access is not gated', async () => {
    const res = await buildApp({ callerRole: 'adult' }).request('/api/reward-config');
    expect(res.status).toBe(200);
  });

  it('returns the family default rate, currency, and each kid with their effective rate', async () => {
    const res = await buildApp({
      callerRole: 'admin',
      tenantRow: { currency: 'AED', stickerRateMinor: 50 },
      kidRows: [
        { id: KID_ID, displayName: 'Iman', avatarEmoji: '🦄', stickerRateMinor: null },
        { id: KID_2_ID, displayName: 'Zayd', avatarEmoji: null, stickerRateMinor: 100 },
      ],
    }).request('/api/reward-config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      currency: string;
      familyRateMinor: number;
      members: Array<{ memberId: string; rateMinor: number | null; effectiveRateMinor: number }>;
    };
    expect(body.currency).toBe('AED');
    expect(body.familyRateMinor).toBe(50);
    expect(body.members).toHaveLength(2);
    // Iman has no override → effective rate falls back to the family default.
    expect(body.members[0]).toMatchObject({
      memberId: KID_ID,
      rateMinor: null,
      effectiveRateMinor: 50,
    });
    // Zayd has his own override → effective rate is HIS rate, not the family default.
    expect(body.members[1]).toMatchObject({
      memberId: KID_2_ID,
      rateMinor: 100,
      effectiveRateMinor: 100,
    });
  });

  it('defaults to a 50-minor-unit family rate and USD when the tenant row is somehow missing', async () => {
    const res = await buildApp({ callerRole: 'admin', tenantRow: null }).request(
      '/api/reward-config',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { currency: string; familyRateMinor: number };
    expect(body.familyRateMinor).toBe(50);
    expect(body.currency).toBe('USD');
  });
});

describe('PUT /api/reward-config: admin-only', () => {
  const put = (body: unknown): RequestInit => ({
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('403 ADMIN_ONLY for a normal user (adult)', async () => {
    const res = await buildApp({ callerRole: 'adult' }).request(
      '/api/reward-config',
      put({ familyRateMinor: 75 }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe('ADMIN_ONLY');
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('403 ADMIN_ONLY for a teen', async () => {
    const res = await buildApp({ callerRole: 'teen' }).request(
      '/api/reward-config',
      put({ familyRateMinor: 75 }),
    );
    expect(res.status).toBe(403);
  });

  it('400 on a negative familyRateMinor', async () => {
    const res = await buildApp({ callerRole: 'admin' }).request(
      '/api/reward-config',
      put({ familyRateMinor: -10 }),
    );
    expect(res.status).toBe(400);
  });

  it('400 on a non-integer (float) familyRateMinor: money must be an integer', async () => {
    const res = await buildApp({ callerRole: 'admin' }).request(
      '/api/reward-config',
      put({ familyRateMinor: 0.5 }),
    );
    expect(res.status).toBe(400);
  });

  it('400 on a negative memberOverrides rateMinor', async () => {
    const res = await buildApp({ callerRole: 'admin' }).request(
      '/api/reward-config',
      put({ memberOverrides: [{ memberId: KID_ID, rateMinor: -5 }] }),
    );
    expect(res.status).toBe(400);
  });

  // FIX 2 (BLOCKER): rate 0 makes cashAsStickers divide by 0 (Infinity/NaN
  // stickers), so `balance < cost` never blocks a redemption. 0 must be
  // rejected, same as any other invalid rate.
  it('400 on a zero familyRateMinor: a free rate is rejected, not just a negative one', async () => {
    const res = await buildApp({ callerRole: 'admin' }).request(
      '/api/reward-config',
      put({ familyRateMinor: 0 }),
    );
    expect(res.status).toBe(400);
  });

  it('400 on a zero memberOverrides rateMinor', async () => {
    const res = await buildApp({ callerRole: 'admin' }).request(
      '/api/reward-config',
      put({ memberOverrides: [{ memberId: KID_ID, rateMinor: 0 }] }),
    );
    expect(res.status).toBe(400);
  });

  // FIX 3 (BLOCKER): no upper bound let an oversized rate reach Postgres'
  // numeric(12,2) column and 500.
  it('400 when familyRateMinor exceeds the cap (100000 = 1000.00)', async () => {
    const res = await buildApp({ callerRole: 'admin' }).request(
      '/api/reward-config',
      put({ familyRateMinor: 100001 }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when a memberOverrides rateMinor exceeds the cap', async () => {
    const res = await buildApp({ callerRole: 'admin' }).request(
      '/api/reward-config',
      put({ memberOverrides: [{ memberId: KID_ID, rateMinor: 999999 }] }),
    );
    expect(res.status).toBe(400);
  });

  it('200 for an admin updating the family rate', async () => {
    let updatedSet: Record<string, unknown> | undefined;
    dbMock.update.mockImplementation(() => ({
      set: (values: Record<string, unknown>) => {
        updatedSet = values;
        return { where: () => Promise.resolve(undefined) };
      },
    }));
    const res = await buildApp({
      callerRole: 'admin',
      tenantRow: { currency: 'AED', stickerRateMinor: 75 },
    }).request('/api/reward-config', put({ familyRateMinor: 75 }));
    expect(res.status).toBe(200);
    expect(updatedSet?.stickerRateMinor).toBe(75);
  });

  it("200 for an admin setting a kid's override, and null clears it", async () => {
    dbMock.update.mockImplementation(() => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }));
    const res = await buildApp({
      callerRole: 'admin',
      kidRows: [{ id: KID_ID, displayName: 'Iman', avatarEmoji: null, stickerRateMinor: null }],
    }).request(
      '/api/reward-config',
      put({ memberOverrides: [{ memberId: KID_ID, rateMinor: null }] }),
    );
    expect(res.status).toBe(200);
  });

  it('silently skips a memberId that does not belong to this tenant (never trusts client input for scoping)', async () => {
    // The "existing members" lookup inside the PUT handler returns empty:
    // simulate by overriding select just for that one extra call.
    let call = 0;
    dbMock.select.mockImplementation(() => {
      call += 1;
      if (call === 1) return chain([{ id: 'm1', role: 'admin' }]); // loadCaller
      return chain([]); // "existing" members scoped-to-tenant lookup → empty
    });
    const app = new Hono();
    const seed: MiddlewareHandler = async (c, next) => {
      c.set('user', { id: USER_ID, email: 's@e.com', claims: {} });
      c.set('userRow', FIXED_USER);
      c.set('tenantId', TENANT_ID);
      await next();
    };
    app.use('*', seed);
    app.route('/api/reward-config', rewardConfigRouter);
    const foreignMemberId = '99999999-9999-4999-8999-999999999999';
    const res = await app.request(
      '/api/reward-config',
      put({ memberOverrides: [{ memberId: foreignMemberId, rateMinor: 100 }] }),
    );
    // The request itself still succeeds (loadConfig runs), it just never
    // writes to a member outside this tenant.
    expect(res.status).toBe(200);
    expect(dbMock.update).not.toHaveBeenCalled();
  });
});
