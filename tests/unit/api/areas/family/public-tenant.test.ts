import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../../../src/security/auth.js';
import { publicTenantRouter } from '../../../../../src/areas/family/public-tenant.js';
import type { User, Tenant, Member } from '../../../../../src/database/schema.js';

// Mock the DB client. The route reaches for `getDb()` directly so we
// stub it at the module boundary; tests inject the chain shape they want.
const dbMock = {
  select: vi.fn(),
  insert: vi.fn(),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
  transaction: vi.fn(),
};
// FHS-351: onboarding now wraps tenant+member creation in db.transaction; the
// tx exposes the same insert chain + execute (for the set_config tenant pin).
dbMock.transaction.mockImplementation((cb: (tx: typeof dbMock) => unknown) => cb(dbMock));
vi.mock('../../../../../src/database/client.js', () => ({
  getDb: () => dbMock,
}));

const ISSUER = 'https://auth.test.local/auth/v1';
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
    role: 'admin',
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
  dbMock.transaction.mockClear();
});

/** No family created by this person yet (FHS-716 check finds nothing). */
function noFamilyYet() {
  dbMock.select.mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
  });
}

/** First select: the family this person created; second: their seat in it. */
function selectsReturn(tenantRows: unknown[], ownSeatRows: unknown[]) {
  const answer = (rows: unknown[]) => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  });
  dbMock.select.mockReturnValueOnce(answer(tenantRows)).mockReturnValueOnce(answer(ownSeatRows));
}

afterEach(() => {
  _resetJwksCacheForTests();
});

describe('FHS-25: POST /api/public/tenant', () => {
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

  it('FHS-715: makes its own private code and ignores an address sent by an older website', async () => {
    const { privateKey, publicJwk } = await genKey();
    noFamilyYet();
    let inserted: { slug?: string; createdBy?: string } = {};
    const tenant = fixedTenant('e29b-41d4');
    let insertCall = 0;
    dbMock.insert.mockImplementation(() => ({
      values: (val: { slug?: string; createdBy?: string }) => {
        insertCall += 1;
        if (insertCall === 1) inserted = val;
        return {
          returning: () => Promise.resolve(insertCall === 1 ? [tenant] : [fixedMember(tenant.id)]),
        };
      },
    }));
    const app = buildAppWithAuth(publicJwk);
    const token = await mintToken(privateKey);
    const res = await app.request('/api/public/tenant', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ familyName: 'The Smith Family', displayName: 'Sam', slug: 'BadSlug' }),
    });
    expect(res.status).toBe(201);
    expect(inserted.slug).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(inserted.createdBy).toBeTruthy();
  });

  it('FHS-716: one family per home: a second create hands back the family they already made', async () => {
    const { privateKey, publicJwk } = await genKey();
    const tenant = fixedTenant('e29b-41d4');
    selectsReturn([tenant], [fixedMember(tenant.id)]);
    const app = buildAppWithAuth(publicJwk);
    const token = await mintToken(privateKey);
    const res = await app.request('/api/public/tenant', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ familyName: 'Another Family', displayName: 'Sam' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenant: { slug: string } };
    expect(body.tenant.slug).toBe('e29b-41d4');
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('FHS-714: welcomes a one-character family name', async () => {
    const { privateKey, publicJwk } = await genKey();
    noFamilyYet();
    const tenant = fixedTenant('a1b2-c3d4');
    let insertCall = 0;
    dbMock.insert.mockImplementation(() => ({
      values: () => ({
        returning: () => {
          insertCall += 1;
          return Promise.resolve(insertCall === 1 ? [tenant] : [fixedMember(tenant.id)]);
        },
      }),
    }));
    const app = buildAppWithAuth(publicJwk);
    const token = await mintToken(privateKey);
    const res = await app.request('/api/public/tenant', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ familyName: '李', displayName: 'B' }),
    });
    expect(res.status).toBe(201);
  });

  it('FHS-715: tries a fresh code if two codes ever clash', async () => {
    const { privateKey, publicJwk } = await genKey();
    noFamilyYet();
    const tenant = fixedTenant('a1b2-c3d4');
    let insertCall = 0;
    dbMock.insert.mockImplementation(() => ({
      values: () => ({
        returning: () => {
          insertCall += 1;
          if (insertCall === 1) {
            const err = new Error('duplicate key value violates unique constraint') as Error & {
              code?: string;
            };
            err.code = '23505';
            return Promise.reject(err);
          }
          return Promise.resolve(insertCall === 2 ? [tenant] : [fixedMember(tenant.id)]);
        },
      }),
    }));
    const app = buildAppWithAuth(publicJwk);
    const token = await mintToken(privateKey);
    const res = await app.request('/api/public/tenant', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ familyName: 'The Khan Family', displayName: 'Sarah' }),
    });
    expect(res.status).toBe(201);
    expect(dbMock.transaction).toHaveBeenCalledTimes(2);
  });
});
