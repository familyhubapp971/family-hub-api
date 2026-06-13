import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../../../apps/api/src/app.js';
import { config } from '../../../../apps/api/src/config.js';
import { KID_ISSUER } from '../../../../apps/api/src/middleware/kid-auth.js';

// FHS-257 — GET /api/kid/me on the REAL app. Proves /api/kid is excluded
// from the parent (ES256) auth middleware and served by the kid HS256
// stack instead — i.e. the issuer↔consumer loop closes end to end.

const KEY = new TextEncoder().encode(config.KID_AUTH_SECRET);
const MEMBER_ID = '44444444-4444-4444-8444-444444444444';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_SLUG = 'khan';

async function mintKidToken(secondsFromNow = 3600): Promise<string> {
  return new SignJWT({ scope: 'child', tenantId: TENANT_ID, tenantSlug: TENANT_SLUG })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(MEMBER_ID)
    .setIssuer(KID_ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + secondsFromNow)
    .sign(KEY);
}

describe('FHS-257 — GET /api/kid/me (real app wiring)', () => {
  it('serves a valid kid token without the parent JWKS path', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memberId: string; tenantId: string; tenantSlug: string };
    expect(body).toEqual({ memberId: MEMBER_ID, tenantId: TENANT_ID, tenantSlug: TENANT_SLUG });
  });

  it('returns 403 KID_REQUIRED when no token is presented', async () => {
    const res = await buildApp().request('/api/kid/me');
    expect(res.status).toBe(403);
    expect((await res.json()).errorCode).toBe('KID_REQUIRED');
  });

  it('returns 401 KID_AUTH_INVALID for a tampered kid token', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/me', {
      headers: { Authorization: `Bearer ${token.slice(0, -3)}xyz` },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).errorCode).toBe('KID_AUTH_INVALID');
  });

  it('returns 403 KID_ON_PARENT_ROUTE when a kid token hits a parent route', async () => {
    // A kid token presented to a parent endpoint is rejected by the
    // global rejectKidTokens guard BEFORE the parent ES256 auth runs.
    const token = await mintKidToken();
    const res = await buildApp().request('/api/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).errorCode).toBe('KID_ON_PARENT_ROUTE');
  });
});
