import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';

// FHS-695: which sign-in passes the server trusts is a setting. Staging points
// AUTH_JWKS_URL / AUTH_ISSUER at our GoTrue; unset, Supabase stays in charge.

const GOTRUE_ISSUER = 'https://fh-api-staging.example/auth/v1';
const settings: Record<string, string | undefined> = {};
const base: Record<string, unknown> = {
  LOG_LEVEL: 'fatal',
  NODE_ENV: 'test',
  JWKS_CACHE_TTL_MS: 600_000,
};

vi.mock('../../../../src/config.js', () => ({
  config: new Proxy(
    {},
    { get: (_t, key: string) => (key in settings ? settings[key] : base[key]) },
  ),
}));

const { authMiddleware, defaultIssuer, defaultJwksUrl } = await import(
  '../../../../src/security/auth.js'
);

afterEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
});

describe('FHS-695: trust settings', () => {
  it('uses Supabase when the GoTrue settings are unset', () => {
    settings.SUPABASE_URL = 'https://abc.supabase.co';
    expect(defaultJwksUrl()?.href).toBe('https://abc.supabase.co/auth/v1/.well-known/jwks.json');
    expect(defaultIssuer()).toBe('https://abc.supabase.co/auth/v1');
  });

  it('uses GoTrue when AUTH_JWKS_URL and AUTH_ISSUER are set, even with SUPABASE_URL present', () => {
    settings.SUPABASE_URL = 'https://abc.supabase.co';
    settings.AUTH_JWKS_URL = 'http://gotrue.railway.internal:9999/.well-known/jwks.json';
    settings.AUTH_ISSUER = GOTRUE_ISSUER;
    expect(defaultJwksUrl()?.href).toBe(
      'http://gotrue.railway.internal:9999/.well-known/jwks.json',
    );
    expect(defaultIssuer()).toBe(GOTRUE_ISSUER);
  });

  it('accepts a GoTrue pass and refuses a Supabase one once GoTrue is trusted', async () => {
    settings.SUPABASE_URL = 'https://abc.supabase.co';
    settings.AUTH_ISSUER = GOTRUE_ISSUER;
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' };
    const app = new Hono();
    app.use('*', authMiddleware({ jwks: createLocalJWKSet({ keys: [jwk] }) }));
    app.get('/x', (c) => c.text('ok'));

    const mint = (iss: string) =>
      new SignJWT({ email: 'a@b.com', role: 'authenticated' })
        .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
        .setSubject('00000000-0000-4000-8000-000000000001')
        .setIssuer(iss)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);

    const ok = await app.request('/x', {
      headers: { authorization: `Bearer ${await mint(GOTRUE_ISSUER)}` },
    });
    expect(ok.status).toBe(200);
    const old = await app.request('/x', {
      headers: { authorization: `Bearer ${await mint('https://abc.supabase.co/auth/v1')}` },
    });
    expect(old.status).toBe(401);
  });
});
