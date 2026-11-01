import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../../../src/security/auth.js';
import { familyAddressRouter } from '../../../../../src/areas/family/family-address.js';
import type { User } from '../../../../../src/database/schema.js';

// FHS-715: an old surname address forwards a family's own members to the
// family's private code, and tells everyone else nothing.

const dbMock = { select: vi.fn(), execute: vi.fn(), transaction: vi.fn() };
dbMock.transaction.mockImplementation((cb: (tx: typeof dbMock) => unknown) => cb(dbMock));
vi.mock('../../../../../src/database/client.js', () => ({ getDb: () => dbMock }));
const mockLoadCaller = vi.fn();
vi.mock('../../../../../src/security/permissions.js', () => ({
  loadCaller: (...args: unknown[]) => mockLoadCaller(...args),
}));

const ISSUER = 'https://auth.test.local/auth/v1';
const KID = 'family-address-kid';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const USER: User = {
  id: USER_ID,
  email: 'sam@example.com',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  Object.assign(publicJwk, { alg: 'ES256', kid: KID, use: 'sig' });
  return { privateKey, publicJwk };
}

function token(privateKey: KeyLike) {
  return new SignJWT({ email: USER.email })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setSubject(USER_ID)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey);
}

function app(publicJwk: JWK, tenantId?: string) {
  const a = new Hono();
  if (tenantId) {
    a.use('*', async (c, next) => {
      c.set('tenantId', tenantId);
      await next();
    });
  }
  a.use(
    '*',
    authMiddleware({
      issuer: ISSUER,
      jwks: async (header: { kid?: string; alg?: string }) => {
        const { importJWK } = await import('jose');
        return (await importJWK(publicJwk, header.alg ?? 'ES256')) as KeyLike;
      },
      userMirrorSync: vi.fn().mockResolvedValue(USER),
    }),
  );
  a.route('/api/family-address', familyAddressRouter);
  return a;
}

/** First select: the family that used this old address; second: the caller's seat in it. */
function selectsReturn(familyRows: unknown[], seatRows: unknown[]) {
  const answer = (rows: unknown[]) => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  });
  dbMock.select.mockReturnValueOnce(answer(familyRows)).mockReturnValueOnce(answer(seatRows));
}

const SMITHS = { id: 't-1', slug: 'e29b-41d4', previousSlug: 'smith', name: 'The Smith Family' };

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.execute.mockResolvedValue({ rows: [] });
});

afterEach(() => _resetJwksCacheForTests());

describe('FHS-715: GET /api/family-address/:oldSlug', () => {
  it("gives a family's own member the new address for an old link", async () => {
    const { privateKey, publicJwk } = await keys();
    selectsReturn([SMITHS], [{ id: 'm-1' }]);
    const res = await app(publicJwk).request('/api/family-address/Smith', {
      headers: { Authorization: `Bearer ${await token(privateKey)}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: 'e29b-41d4', name: 'The Smith Family' });
  });

  it('tells someone outside the family nothing, so an old surname reveals no family', async () => {
    const { privateKey, publicJwk } = await keys();
    selectsReturn([SMITHS], []);
    const res = await app(publicJwk).request('/api/family-address/smith', {
      headers: { Authorization: `Bearer ${await token(privateKey)}` },
    });
    expect(res.status).toBe(404);
  });

  it('answers not found for an address no family ever used', async () => {
    const { privateKey, publicJwk } = await keys();
    selectsReturn([], []);
    const res = await app(publicJwk).request('/api/family-address/nobody', {
      headers: { Authorization: `Bearer ${await token(privateKey)}` },
    });
    expect(res.status).toBe(404);
  });

  it('needs a signed-in person', async () => {
    const { publicJwk } = await keys();
    const res = await app(publicJwk).request('/api/family-address/smith');
    expect(res.status).toBe(401);
  });

  it("tells a family's member its code and the old address it replaced", async () => {
    const { privateKey, publicJwk } = await keys();
    mockLoadCaller.mockResolvedValueOnce({ id: 'm-1', role: 'admin' });
    dbMock.select.mockReturnValueOnce({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ slug: 'e29b-41d4', previousSlug: 'smith' }]),
        }),
      }),
    });
    const res = await app(publicJwk, 't-1').request('/api/family-address', {
      headers: { Authorization: `Bearer ${await token(privateKey)}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: 'e29b-41d4', previousSlug: 'smith' });
  });

  it("keeps a family's code from someone who is not a member", async () => {
    const { privateKey, publicJwk } = await keys();
    mockLoadCaller.mockResolvedValueOnce(null);
    const res = await app(publicJwk, 't-1').request('/api/family-address', {
      headers: { Authorization: `Bearer ${await token(privateKey)}` },
    });
    expect(res.status).toBe(403);
  });
});
