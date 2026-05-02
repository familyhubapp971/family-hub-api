import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authMiddleware,
  _resetJwksCacheForTests,
} from '../../../../apps/api/src/middleware/auth.js';
import { publicTenantRouter } from '../../../../apps/api/src/routes/public-tenant.js';
import type { User, Tenant, Member } from '../../../../apps/api/src/db/schema.js';

// Mock the DB client. The route reaches for `getDb()` directly so we
// stub it at the module boundary; tests inject the chain shape they want.
const dbMock = {
  select: vi.fn(),
  insert: vi.fn(),
};
vi.mock('../../../../apps/api/src/db/client.js', () => ({
  getDb: () => dbMock,
}));

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'pt-test-kid';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const USER_EMAIL = 'sarah@example.com';

async function genKey() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = 'ES256';
  publicJwk.kid = KID;
  publicJwk.use = 'sig';
  return { privateKey, publicJwk };
}

async function mintToken(privateKey: KeyLike) {
  return new SignJWT({ email: USER_EMAIL })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setSubject(USER_ID)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey);
}

function makeJwks(publicJwk: JWK) {
  return async (header: { kid?: string; alg?: string }) => {
    const { importJWK } = await import('jose');
    if (header.kid !== publicJwk.kid) throw new Error(`no key for kid ${header.kid}`);
    return (await importJWK(publicJwk, header.alg ?? 'ES256')) as KeyLike;
  };
}

const FIXED_USER: User = {
  id: USER_ID,
  email: USER_EMAIL,
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
  updatedAt: new Date('2026-05-01T00:00:00.000Z'),
};

function fixedTenant(slug: string): Tenant {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    slug,
    name: 'The Khan Family',
    status: 'active',
    plan: 'starter',
    timezone: 'UTC',
    currency: 'USD',
    createdAt: new Date('2026-05-02T00:00:00.000Z'),
    updatedAt: new Date('2026-05-02T00:00:00.000Z'),
  };
}

function fixedMember(tenantId: string): Member {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    tenantId,
    userId: USER_ID,
    displayName: 'Sarah Khan',
    role: 'adult',
    avatarEmoji: null,
    createdAt: new Date('2026-05-02T00:00:00.000Z'),
    updatedAt: new Date('2026-05-02T00:00:00.000Z'),
  };
}

function buildAppWithAuth(publicJwk: JWK, sync = vi.fn().mockResolvedValue(FIXED_USER)) {
  const app = new Hono();
  app.use('*', authMiddleware({ issuer: ISSUER, jwks: makeJwks(publicJwk), userMirrorSync: sync }));
  app.route('/api/public/tenant', publicTenantRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
});

afterEach(() => {
  _resetJwksCacheForTests();
});

describe('FHS-25 — POST /api/public/tenant', () => {
  it('returns 401 without an Authorization header', async () => {
    const { publicJwk } = await genKey();
    const app = buildAppWithAuth(publicJwk);
    const res = await app.request('/api/public/tenant', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when the body is missing required fields', async () => {
    const { privateKey, publicJwk } = await genKey();
    const app = buildAppWithAuth(publicJwk);
    const token = await mintToken(privateKey);
    const res = await app.request('/api/public/tenant', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ familyName: 'X' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues?: unknown };
    expect(body.error).toBe('invalid request');
    expect(body.issues).toBeDefined();
  });

  it('returns 400 when the slug fails the regex (uppercase)', async () => {
    const { privateKey, publicJwk } = await genKey();
    const app = buildAppWithAuth(publicJwk);
    const token = await mintToken(privateKey);
    const res = await app.request('/api/public/tenant', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        familyName: 'The Khan Family',
        displayName: 'Sarah',
        slug: 'BadSlug',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 409 when the slug already exists (pre-check path)', async () => {
    const { privateKey, publicJwk } = await genKey();
    // Pre-check returns one row → 409 before we touch insert.
    dbMock.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: 'existing' }]),
        }),
      }),
    });
    const app = buildAppWithAuth(publicJwk);
    const token = await mintToken(privateKey);
    const res = await app.request('/api/public/tenant', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        familyName: 'The Khan Family',
        displayName: 'Sarah',
        slug: 'khan',
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; field?: string; slug?: string };
    expect(body.error).toBe('slug taken');
    expect(body.field).toBe('slug');
    expect(body.slug).toBe('khan');
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('returns 201 with the new tenant + member on the happy path', async () => {
    const { privateKey, publicJwk } = await genKey();
    dbMock.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    });
    const tenant = fixedTenant('khan');
    const member = fixedMember(tenant.id);
    let insertCall = 0;
    dbMock.insert.mockImplementation(() => ({
      values: () => ({
        returning: () => {
          insertCall += 1;
          return Promise.resolve(insertCall === 1 ? [tenant] : [member]);
        },
      }),
    }));
    const app = buildAppWithAuth(publicJwk);
    const token = await mintToken(privateKey);
    const res = await app.request('/api/public/tenant', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        familyName: 'The Khan Family',
        displayName: 'Sarah Khan',
        slug: 'khan',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      tenant: { id: string; slug: string; name: string };
      member: { id: string; tenantId: string; displayName: string; role: string };
    };
    expect(body.tenant.slug).toBe('khan');
    expect(body.tenant.name).toBe('The Khan Family');
    expect(body.member.displayName).toBe('Sarah Khan');
    expect(body.member.role).toBe('adult');
    expect(body.member.tenantId).toBe(tenant.id);
  });

  it('returns 409 when the insert hits a unique violation (race)', async () => {
    const { privateKey, publicJwk } = await genKey();
    dbMock.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    });
    dbMock.insert.mockImplementation(() => ({
      values: () => ({
        returning: () => {
          const err = new Error('duplicate key value violates unique constraint') as Error & {
            code?: string;
          };
          err.code = '23505';
          return Promise.reject(err);
        },
      }),
    }));
    const app = buildAppWithAuth(publicJwk);
    const token = await mintToken(privateKey);
    const res = await app.request('/api/public/tenant', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        familyName: 'The Khan Family',
        displayName: 'Sarah',
        slug: 'khan',
      }),
    });
    expect(res.status).toBe(409);
  });
});
