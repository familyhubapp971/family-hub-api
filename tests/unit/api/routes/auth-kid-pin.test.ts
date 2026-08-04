import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import {
  kidPinRouter,
  _resetKidPinBucketsForTests,
} from '../../../../apps/api/src/routes/auth-kid-pin.js';

// FHS-236: POST /api/auth/kid-pin. DB stubbed at module boundary.

const dbMock = { select: vi.fn() };
vi.mock('../../../../apps/api/src/db/client.js', () => ({
  getDb: () => dbMock,
  pinRequestTenant: async () => {},
}));

vi.mock('../../../../apps/api/src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../apps/api/src/config.js')>(
    '../../../../apps/api/src/config.js',
  );
  return {
    ...actual,
    config: {
      ...actual.config,
      KID_AUTH_SECRET: 'a-secret-of-at-least-thirty-two-chars-x',
      KID_PIN_LOCKOUT_MAX_ATTEMPTS: 3,
      KID_PIN_LOCKOUT_MS: 60_000,
      KID_JWT_TTL_MS: 60 * 60_000,
    },
  };
});

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_SLUG = 'khans';

interface MemberRow {
  id: string;
  displayName: string;
  avatarEmoji: string | null;
  isChild: boolean;
  pinHash: string | null;
}

function buildApp(opts: { tenantHit?: boolean; memberHit?: boolean; member?: Partial<MemberRow> }) {
  let selectIdx = 0;
  dbMock.select.mockImplementation(() => {
    selectIdx += 1;
    if (selectIdx === 1) {
      // Tenant lookup by slug.
      return {
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve(
                opts.tenantHit === false ? [] : [{ id: TENANT_ID, slug: TENANT_SLUG }],
              ),
          }),
        }),
      };
    }
    // Member lookup.
    return {
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve(
              opts.memberHit === false
                ? []
                : [
                    {
                      id: MEMBER_ID,
                      displayName: 'Iman',
                      avatarEmoji: '👧',
                      isChild: true,
                      pinHash: null,
                      ...(opts.member ?? {}),
                    },
                  ],
            ),
        }),
      }),
    };
  });

  const app = new Hono();
  app.route('/api/auth/kid-pin', kidPinRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  _resetKidPinBucketsForTests();
});

function postBody(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('FHS-236: POST /api/auth/kid-pin', () => {
  it('returns 400 when pin is not 4 digits', async () => {
    const app = buildApp({});
    const res = await app.request(
      '/api/auth/kid-pin',
      postBody({ tenantSlug: TENANT_SLUG, memberId: MEMBER_ID, pin: 'abcd' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when memberId is not a UUID', async () => {
    const app = buildApp({});
    const res = await app.request(
      '/api/auth/kid-pin',
      postBody({ tenantSlug: TENANT_SLUG, memberId: 'not-uuid', pin: '1234' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when tenantSlug is invalid', async () => {
    const app = buildApp({});
    const res = await app.request(
      '/api/auth/kid-pin',
      postBody({ tenantSlug: 'BAD slug!!', memberId: MEMBER_ID, pin: '1234' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 when the tenant does not exist', async () => {
    const app = buildApp({ tenantHit: false });
    const res = await app.request(
      '/api/auth/kid-pin',
      postBody({ tenantSlug: TENANT_SLUG, memberId: MEMBER_ID, pin: '1234' }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when the member does not exist in the tenant', async () => {
    const app = buildApp({ memberHit: false });
    const res = await app.request(
      '/api/auth/kid-pin',
      postBody({ tenantSlug: TENANT_SLUG, memberId: MEMBER_ID, pin: '1234' }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when member exists but is_child is false', async () => {
    const hash = await bcrypt.hash('1234', 4);
    const app = buildApp({ member: { isChild: false, pinHash: hash } });
    const res = await app.request(
      '/api/auth/kid-pin',
      postBody({ tenantSlug: TENANT_SLUG, memberId: MEMBER_ID, pin: '1234' }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when pin_hash is null (PIN never set)', async () => {
    const app = buildApp({ member: { isChild: true, pinHash: null } });
    const res = await app.request(
      '/api/auth/kid-pin',
      postBody({ tenantSlug: TENANT_SLUG, memberId: MEMBER_ID, pin: '1234' }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when the bcrypt comparison fails', async () => {
    const hash = await bcrypt.hash('9999', 4);
    const app = buildApp({ member: { isChild: true, pinHash: hash } });
    const res = await app.request(
      '/api/auth/kid-pin',
      postBody({ tenantSlug: TENANT_SLUG, memberId: MEMBER_ID, pin: '1234' }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 200 with a JWT + member info on a valid PIN', async () => {
    const hash = await bcrypt.hash('1234', 4);
    const app = buildApp({ member: { isChild: true, pinHash: hash } });
    const res = await app.request(
      '/api/auth/kid-pin',
      postBody({ tenantSlug: TENANT_SLUG, memberId: MEMBER_ID, pin: '1234' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      member: { id: string; tenantSlug: string };
      expiresAt: string;
    };
    expect(body.token).toMatch(/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/);
    expect(body.member.id).toBe(MEMBER_ID);
    expect(body.member.tenantSlug).toBe(TENANT_SLUG);
    expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('locks the bucket after 3 consecutive failures and returns 429', async () => {
    const app = buildApp({ memberHit: false });
    for (let i = 0; i < 3; i++) {
      const res = await app.request(
        '/api/auth/kid-pin',
        postBody({ tenantSlug: TENANT_SLUG, memberId: MEMBER_ID, pin: '0000' }),
      );
      expect(res.status).toBe(401);
    }
    // Build a fresh app: buckets persist across `buildApp` calls
    // because the module-level Map isn't per-instance.
    const lockedApp = buildApp({ memberHit: false });
    const res = await lockedApp.request(
      '/api/auth/kid-pin',
      postBody({ tenantSlug: TENANT_SLUG, memberId: MEMBER_ID, pin: '0000' }),
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { errorCode: string; retryAfter: number };
    expect(body.errorCode).toBe('KID_PIN_LOCKED');
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it('clears the bucket on a successful login', async () => {
    const hash = await bcrypt.hash('1234', 4);
    // 2 failures (under the 3-attempt lockout)
    const app1 = buildApp({ memberHit: false });
    await app1.request(
      '/api/auth/kid-pin',
      postBody({ tenantSlug: TENANT_SLUG, memberId: MEMBER_ID, pin: '0000' }),
    );
    await app1.request(
      '/api/auth/kid-pin',
      postBody({ tenantSlug: TENANT_SLUG, memberId: MEMBER_ID, pin: '0000' }),
    );
    // Successful login resets the counter
    const app2 = buildApp({ member: { isChild: true, pinHash: hash } });
    const ok = await app2.request(
      '/api/auth/kid-pin',
      postBody({ tenantSlug: TENANT_SLUG, memberId: MEMBER_ID, pin: '1234' }),
    );
    expect(ok.status).toBe(200);
    // Two more failures should NOT lock: counter was cleared
    const app3 = buildApp({ memberHit: false });
    const r1 = await app3.request(
      '/api/auth/kid-pin',
      postBody({ tenantSlug: TENANT_SLUG, memberId: MEMBER_ID, pin: '0000' }),
    );
    const r2 = await app3.request(
      '/api/auth/kid-pin',
      postBody({ tenantSlug: TENANT_SLUG, memberId: MEMBER_ID, pin: '0000' }),
    );
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
  });
});
