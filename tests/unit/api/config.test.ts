import { describe, it, expect } from 'vitest';
import { configSchema } from '../../../src/config';

// FHS-516: lock the E2E_TEST_JWKS security gate. The var wires a local test
// JWKS into the api's JWT verification so the e2e harness can mint its own
// tokens. It is fully public (fixed key committed in tests/e2e/support/auth),
// so it must be honoured ONLY under NODE_ENV=test: never on a real deploy
// (production/staging both run NODE_ENV=production) and never under a
// developer's plain `pnpm dev` (NODE_ENV=development, which points at the real
// staging Supabase project). The activation itself lives in auth.ts; here we
// prove config REFUSES TO BOOT (fail-closed) whenever the var is set outside
// test, and boots cleanly when it isn't.

const JWKS = '{"keys":[]}';

function baseEnv(overrides: Record<string, string>) {
  // Minimal env that satisfies the production-only required-field checks so
  // the ONLY variable under test is E2E_TEST_JWKS × NODE_ENV.
  return {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    SUPABASE_URL: 'https://example.supabase.co',
    KID_AUTH_SECRET: 'a-real-kid-secret-at-least-32-chars-long',
    CALENDAR_FEED_SECRET: 'a-real-calendar-secret-at-least-32-chars',
    ...overrides,
  };
}

describe('config: E2E_TEST_JWKS gate (FHS-516)', () => {
  it('refuses to boot when set under NODE_ENV=production', () => {
    const r = configSchema.safeParse(baseEnv({ NODE_ENV: 'production', E2E_TEST_JWKS: JWKS }));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('E2E_TEST_JWKS'))).toBe(true);
    }
  });

  it('refuses to boot when set under NODE_ENV=development (plain `pnpm dev`)', () => {
    const r = configSchema.safeParse(baseEnv({ NODE_ENV: 'development', E2E_TEST_JWKS: JWKS }));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('E2E_TEST_JWKS'))).toBe(true);
    }
  });

  it('boots when set under NODE_ENV=test (the e2e harness)', () => {
    const r = configSchema.safeParse(baseEnv({ NODE_ENV: 'test', E2E_TEST_JWKS: JWKS }));
    expect(r.success).toBe(true);
  });

  it('boots when unset under NODE_ENV=production (unchanged real-deploy behaviour)', () => {
    const r = configSchema.safeParse(baseEnv({ NODE_ENV: 'production' }));
    expect(r.success).toBe(true);
  });
});

// FHS-695: whose sign-in passes to trust. AUTH_JWKS_URL and AUTH_ISSUER only
// make sense together, and production needs Supabase or that pair.
describe('config: GoTrue trust settings (FHS-695)', () => {
  const JWKS_URL = 'http://gotrue.railway.internal:9999/.well-known/jwks.json';
  const ISSUER = 'https://fh-api-staging.up.railway.app/auth/v1';

  it('refuses AUTH_JWKS_URL without AUTH_ISSUER', () => {
    const r = configSchema.safeParse(baseEnv({ NODE_ENV: 'production', AUTH_JWKS_URL: JWKS_URL }));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes('AUTH_ISSUER'))).toBe(true);
  });

  it('refuses AUTH_ISSUER without AUTH_JWKS_URL', () => {
    const r = configSchema.safeParse(baseEnv({ NODE_ENV: 'production', AUTH_ISSUER: ISSUER }));
    expect(r.success).toBe(false);
  });

  it('boots production on the GoTrue pair alone, with no SUPABASE_URL', () => {
    const env: Record<string, string> = baseEnv({
      NODE_ENV: 'production',
      AUTH_JWKS_URL: JWKS_URL,
      AUTH_ISSUER: ISSUER,
    });
    delete env.SUPABASE_URL;
    expect(configSchema.safeParse(env).success).toBe(true);
  });

  it('refuses production with neither SUPABASE_URL nor the GoTrue pair', () => {
    const env: Record<string, string> = baseEnv({ NODE_ENV: 'production' });
    delete env.SUPABASE_URL;
    const r = configSchema.safeParse(env);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes('SUPABASE_URL'))).toBe(true);
  });
});

// FHS-698: GoTrue's signing keys for admin calls are optional.
describe('config: GOTRUE_ADMIN_SIGNING_KEYS (FHS-698)', () => {
  it('is optional', () => {
    expect(configSchema.safeParse(baseEnv({ NODE_ENV: 'production' })).success).toBe(true);
  });

  it('accepts a key list', () => {
    const r = configSchema.safeParse(
      baseEnv({ NODE_ENV: 'production', GOTRUE_ADMIN_SIGNING_KEYS: '[{"kty":"EC"}]' }),
    );
    expect(r.success).toBe(true);
  });
});

describe('config: PASSWORD_SIGNIN_EMAILS (FHS-704)', () => {
  const parse = (v?: string) => {
    const r = configSchema.safeParse(
      baseEnv({
        NODE_ENV: 'production',
        ...(v === undefined ? {} : { PASSWORD_SIGNIN_EMAILS: v }),
      }),
    );
    if (!r.success) throw new Error('config did not parse');
    return r.data.PASSWORD_SIGNIN_EMAILS;
  };

  it('allows no one when unset', () => {
    expect(parse()).toEqual([]);
  });

  it('reads a comma list as lower-case addresses, ignoring blanks', () => {
    expect(parse(' E2E@FamilyHub.test, ,other@example.com ')).toEqual([
      'e2e@familyhub.test',
      'other@example.com',
    ]);
  });
});
