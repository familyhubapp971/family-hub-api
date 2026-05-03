import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authMiddleware,
  _resetJwksCacheForTests,
} from '../../../../apps/api/src/middleware/auth.js';
import { meRouter, meResponseSchema } from '../../../../apps/api/src/routes/me.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// /api/me now joins members → tenants for the FHS-37 onboarding gate;
// stub getDb so the route uses our handcrafted chain instead of opening
// a real pool.
const dbMock = { select: vi.fn() };
vi.mock('../../../../apps/api/src/db/client.js', () => ({
  getDb: () => dbMock,
}));

beforeEach(() => {
  // Default: user belongs to no tenants. Individual tests override.
  dbMock.select.mockReturnValue({
    from: () => ({ innerJoin: () => ({ where: () => Promise.resolve([]) }) }),
  });
});

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'me-test-kid';
const USER_ID = '00000000-0000-4000-8000-000000000999';
const USER_EMAIL = 'mirror@example.com';

async function generateEs256Key() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = 'ES256';
  publicJwk.kid = KID;
  publicJwk.use = 'sig';
  return { privateKey, publicJwk };
}

// JS default-param values fire when `undefined` is passed, so we use a
// sentinel object instead of `string | undefined` to support an explicit
// "no email claim" case.
const NO_EMAIL = Symbol('no-email');
type EmailArg = string | typeof NO_EMAIL;
async function mintToken(privateKey: KeyLike, sub: string = USER_ID, email: EmailArg = USER_EMAIL) {
  const payload: Record<string, unknown> = {};
  if (email !== NO_EMAIL) payload['email'] = email;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey);
}

function makeJwksResolver(publicJwk: JWK) {
  return async (header: { kid?: string; alg?: string }) => {
    const { importJWK } = await import('jose');
    if (header.kid !== publicJwk.kid) throw new Error(`no key for kid ${header.kid}`);
    return (await importJWK(publicJwk, header.alg ?? 'ES256')) as KeyLike;
  };
}

const FIXED_ROW: User = {
  id: USER_ID,
  email: USER_EMAIL,
  createdAt: new Date('2026-01-15T10:30:00.000Z'),
  updatedAt: new Date('2026-04-30T11:00:00.000Z'),
};

afterEach(() => {
  _resetJwksCacheForTests();
});

describe('FHS-194 — GET /api/me', () => {
  it('returns 401 without an Authorization header', async () => {
    const { publicJwk } = await generateEs256Key();
    const app = new Hono();
    app.use(
      '*',
      authMiddleware({
        issuer: ISSUER,
        jwks: makeJwksResolver(publicJwk),
        userMirrorSync: vi.fn(),
      }),
    );
    app.route('/api/me', meRouter);

    const res = await app.request('/api/me');
    expect(res.status).toBe(401);
  });

  it('returns the mirror row projected as { id, email, createdAt }', async () => {
    const { privateKey, publicJwk } = await generateEs256Key();
    const sync = vi.fn().mockResolvedValue(FIXED_ROW);
    const app = new Hono();
    app.use(
      '*',
      authMiddleware({ issuer: ISSUER, jwks: makeJwksResolver(publicJwk), userMirrorSync: sync }),
    );
    app.route('/api/me', meRouter);

    const token = await mintToken(privateKey);
    const res = await app.request('/api/me', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = meResponseSchema.parse(body);
    expect(parsed).toEqual({
      id: USER_ID,
      email: USER_EMAIL,
      createdAt: '2026-01-15T10:30:00.000Z',
      tenants: [],
    });

    // Mirror sync was called with the verified claims.
    expect(sync).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledWith({ id: USER_ID, email: USER_EMAIL });
  });

  it('returns 401 when the JWT lacks an email claim (mirror table requires email)', async () => {
    const { privateKey, publicJwk } = await generateEs256Key();
    const sync = vi.fn();
    const app = new Hono();
    app.use(
      '*',
      authMiddleware({ issuer: ISSUER, jwks: makeJwksResolver(publicJwk), userMirrorSync: sync }),
    );
    app.route('/api/me', meRouter);

    const token = await mintToken(privateKey, USER_ID, NO_EMAIL);
    const res = await app.request('/api/me', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(401);
    expect(sync).not.toHaveBeenCalled();
  });

  it('returns 500 when the mirror sync throws (and never sets userRow)', async () => {
    const { privateKey, publicJwk } = await generateEs256Key();
    const sync = vi.fn().mockRejectedValue(new Error('db unreachable'));
    const app = new Hono();
    app.use(
      '*',
      authMiddleware({ issuer: ISSUER, jwks: makeJwksResolver(publicJwk), userMirrorSync: sync }),
    );
    app.route('/api/me', meRouter);

    const token = await mintToken(privateKey);
    const res = await app.request('/api/me', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(500);
  });
});
