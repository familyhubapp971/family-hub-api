import { describe, it, expect } from 'vitest';
import { configSchema } from '../../../apps/api/src/config';

// FHS-516 — lock the E2E_TEST_JWKS security gate. The var wires a local test
// JWKS into the api's JWT verification so the e2e harness can mint its own
// tokens. It is fully public (fixed key committed in tests/e2e/support/auth),
// so it must be honoured ONLY under NODE_ENV=test — never on a real deploy
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

describe('config — E2E_TEST_JWKS gate (FHS-516)', () => {
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
