import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  kidAuthMiddleware,
  requireKidAuth,
  rejectKidTokens,
  getKidAuth,
  KID_ISSUER,
} from '../../../../apps/api/src/middleware/kid-auth.js';

// FHS-257 — kid JWT consumer middleware. Verifies the HS256 kid token,
// sets kidAuth, and provides the 403 guards for cross-routing.

const SECRET = 'test-only-kid-auth-secret-at-least-32-chars-long';
const KEY = new TextEncoder().encode(SECRET);
const MEMBER_ID = '44444444-4444-4444-8444-444444444444';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_SLUG = 'khan';

interface KidClaims {
  scope?: string;
  tenantId?: string;
  tenantSlug?: string;
  iss?: string;
  sub?: string;
  expSecondsFromNow?: number;
}

async function mintKidToken(over: KidClaims = {}): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + (over.expSecondsFromNow ?? 3600);
  return new SignJWT({
    scope: over.scope ?? 'child',
    tenantId: over.tenantId ?? TENANT_ID,
    tenantSlug: over.tenantSlug ?? TENANT_SLUG,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(over.sub ?? MEMBER_ID)
    .setIssuer(over.iss ?? KID_ISSUER)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(KEY);
}

// A synthetic app: a kid-only route (kidAuthMiddleware + requireKidAuth)
// and a parent-only route (rejectKidTokens then a 200 handler).
function buildApp(secret = SECRET) {
  const app = new Hono();
  app.use('/kid/*', kidAuthMiddleware({ secret }));
  app.use('/kid/*', requireKidAuth);
  app.get('/kid/me', (c) => c.json(getKidAuth(c)));

  app.use('/parent/*', rejectKidTokens);
  app.get('/parent/data', (c) => c.json({ ok: true }));
  return app;
}

function bearer(token: string): RequestInit {
  return { headers: { Authorization: `Bearer ${token}` } };
}

describe('FHS-257 — kid-only route (kidAuthMiddleware + requireKidAuth)', () => {
  it('lets a valid kid token through and populates kidAuth', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request('/kid/me', bearer(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memberId: string; tenantId: string; tenantSlug: string };
    expect(body).toEqual({ memberId: MEMBER_ID, tenantId: TENANT_ID, tenantSlug: TENANT_SLUG });
  });

  it('rejects a tampered kid token with 401 KID_AUTH_INVALID', async () => {
    const token = await mintKidToken();
    const tampered = `${token.slice(0, -3)}xyz`;
    const res = await buildApp().request('/kid/me', bearer(tampered));
    expect(res.status).toBe(401);
    expect((await res.json()).errorCode).toBe('KID_AUTH_INVALID');
  });

  it('rejects an expired kid token with 401 KID_AUTH_INVALID', async () => {
    const token = await mintKidToken({ expSecondsFromNow: -60 });
    const res = await buildApp().request('/kid/me', bearer(token));
    expect(res.status).toBe(401);
    expect((await res.json()).errorCode).toBe('KID_AUTH_INVALID');
  });

  it('rejects a kid token signed with the wrong secret', async () => {
    const token = await new SignJWT({
      scope: 'child',
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(MEMBER_ID)
      .setIssuer(KID_ISSUER)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(new TextEncoder().encode('a-totally-different-secret-32-characters'));
    const res = await buildApp().request('/kid/me', bearer(token));
    expect(res.status).toBe(401);
    expect((await res.json()).errorCode).toBe('KID_AUTH_INVALID');
  });

  it('rejects a kid-issuer token missing tenant claims with 401', async () => {
    // iss + scope look like a kid token, but tenantId is absent.
    const token = await new SignJWT({ scope: 'child' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(MEMBER_ID)
      .setIssuer(KID_ISSUER)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(KEY);
    const res = await buildApp().request('/kid/me', bearer(token));
    expect(res.status).toBe(401);
    expect((await res.json()).errorCode).toBe('KID_AUTH_INVALID');
  });

  it('returns 403 KID_REQUIRED when no token is presented', async () => {
    const res = await buildApp().request('/kid/me');
    expect(res.status).toBe(403);
    expect((await res.json()).errorCode).toBe('KID_REQUIRED');
  });

  it('returns 403 KID_REQUIRED when a parent (non-kid) token hits a kid route', async () => {
    // A parent-shaped token: different issuer, no child scope.
    const parentToken = await new SignJWT({ email: 'mum@example.com' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('parent-user-id')
      .setIssuer('https://supabase.local/auth/v1')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(KEY);
    const res = await buildApp().request('/kid/me', bearer(parentToken));
    expect(res.status).toBe(403);
    expect((await res.json()).errorCode).toBe('KID_REQUIRED');
  });
});

describe('FHS-257 — parent-only route (rejectKidTokens)', () => {
  it('returns 403 KID_ON_PARENT_ROUTE when a kid token hits a parent route', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request('/parent/data', bearer(token));
    expect(res.status).toBe(403);
    expect((await res.json()).errorCode).toBe('KID_ON_PARENT_ROUTE');
  });

  it('lets a non-kid request through to the parent handler', async () => {
    const parentToken = await new SignJWT({ email: 'mum@example.com' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('parent-user-id')
      .setIssuer('https://supabase.local/auth/v1')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(KEY);
    const res = await buildApp().request('/parent/data', bearer(parentToken));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('lets an unauthenticated request through (parent auth handles it later)', async () => {
    const res = await buildApp().request('/parent/data');
    expect(res.status).toBe(200);
  });
});
