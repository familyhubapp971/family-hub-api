// FHS-460: shared fixture loader for the authenticated-session scenarios
// (smoke/load/stress/soak). Centralised so all four scenarios read + log
// in the fixtures the SAME way, exactly ONCE per run, in setup(), not
// once per VU or per iteration.
//
// IMPORTANT: k6's open() may only be called from the init context (the
// module's top level, evaluated once as the script initialises), NOT from
// inside a setup()/default() function body, see
// https://k6.io/docs/using-k6/test-lifecycle/#the-init-context. So the
// actual file read happens here, at import time, guarded by whether
// LOAD_FIXTURES was passed; loadFixtures() below just hands back the
// already-read text. Every scenario's setup() calls loadFixtures() +
// loginAllFixtures(), that's still "setup reads the fixtures", just
// with the k6-mandated open() call one file up.
//
// Fixtures shape (see bin/seed-load-tenants.mjs, which writes this):
//   [{ tenantSlug, parent: { email, password }, kids: [{ memberId, pin }] }]

import { kidLogin, parentLogin } from './auth.js';

const RAW_FIXTURES = __ENV.LOAD_FIXTURES ? open(__ENV.LOAD_FIXTURES) : null;

const SUPABASE_URL = __ENV.SUPABASE_URL || __ENV.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = __ENV.SUPABASE_ANON_KEY || __ENV.VITE_SUPABASE_ANON_KEY;

/**
 * Parses the fixtures file read at init time. Returns [] (never throws)
 * when LOAD_FIXTURES wasn't set, so scenarios can fall back to a
 * health-only workload instead of failing the whole run.
 */
export function loadFixtures() {
  if (!RAW_FIXTURES) {
    console.warn(
      '[perf] LOAD_FIXTURES not set: running a HEALTH-ONLY fallback workload. ' +
        'This does NOT exercise any real authenticated path. Seed synthetic ' +
        'tenants first: node tests/performance/bin/seed-load-tenants.mjs, ' +
        'then re-run with -e LOAD_FIXTURES=<path-to-fixtures.json>. See ' +
        'tests/performance/README.md.',
    );
    return [];
  }
  return JSON.parse(RAW_FIXTURES);
}

/**
 * Logs in every kid (always, no external dependency, needs only the api)
 * and every parent (only when SUPABASE_URL + SUPABASE_ANON_KEY are set),
 * ONCE per fixture, during setup(). Returns the same array with `.token`
 * attached to each kid and to `.parent`.
 */
export function loginAllFixtures(baseUrl, fixtures) {
  const canLoginParents = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
  if (!canLoginParents && fixtures.length > 0) {
    console.warn(
      '[perf] SUPABASE_URL/SUPABASE_ANON_KEY not set: skipping parent login for ' +
        'this run. Kid sessions still run; parent sessions (dashboard, /api/me, ' +
        'etc.) are skipped. See tests/performance/README.md for the manual step ' +
        'to create Supabase parent accounts for the seeded synthetic tenants.',
    );
  }
  return fixtures.map((fixture) => ({
    ...fixture,
    parent: {
      ...fixture.parent,
      token: canLoginParents
        ? parentLogin(SUPABASE_URL, SUPABASE_ANON_KEY, {
            email: fixture.parent.email,
            password: fixture.parent.password,
          })
        : undefined,
    },
    kids: fixture.kids.map((kid) => ({
      ...kid,
      token: kidLogin(baseUrl, {
        tenantSlug: fixture.tenantSlug,
        memberId: kid.memberId,
        pin: kid.pin,
      }),
    })),
  }));
}
