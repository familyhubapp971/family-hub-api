// FHS-197 — k6 auth-smoke scenario.
//
// Logs in once via Supabase password grant (in setup()), then hammers
// GET /api/me with the bearer token for 30 s. Records p95 baseline so
// regressions on the protected request path show up early.
//
// Run locally:
//   set -a; source .env.local; set +a
//   k6 run tests/performance/scenarios/auth-smoke.js
//
// Override target API:
//   k6 run -e BASE_URL=https://api-staging-5500.up.railway.app \
//          tests/performance/scenarios/auth-smoke.js
//
// Required env vars (from .env.local for local; CI secrets for runs):
//   BASE_URL                — api origin (default: http://localhost:3001)
//   SUPABASE_URL            — Supabase project base URL (or VITE_SUPABASE_URL)
//   SUPABASE_ANON_KEY       — public anon key (or VITE_SUPABASE_ANON_KEY)
//   E2E_USER_EMAIL          — synthetic e2e user email
//   E2E_USER_PASSWORD       — synthetic e2e user password

import http from 'k6/http';
import { check, sleep, fail } from 'k6';
import { BASE_URL, PROFILES, THRESHOLDS } from '../config.js';
export { handleSummary } from '../scripts/report.js';

const SUPABASE_URL = __ENV.SUPABASE_URL || __ENV.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = __ENV.SUPABASE_ANON_KEY || __ENV.VITE_SUPABASE_ANON_KEY;
const E2E_EMAIL = __ENV.E2E_USER_EMAIL;
const E2E_PASSWORD = __ENV.E2E_USER_PASSWORD;

export const options = {
  vus: PROFILES.smoke.vus,
  duration: PROFILES.smoke.duration,
  thresholds: {
    // Tag-scoped — only /api/me requests count against the read-budget,
    // so the login round-trip in setup() doesn't skew the result.
    'http_req_duration{endpoint:me}': [`p(95)<${THRESHOLDS.p95_response}`],
    'http_req_failed{endpoint:me}': [`rate<${THRESHOLDS.max_error_rate_smoke}`],
  },
};

// One-shot login. setup() runs once before the test starts; its return
// value is passed to every default() iteration. 1 token → N requests.
// Trade-off: token expiry (~1h on Supabase) > smoke duration (30s), so
// token refresh inside the loop is unnecessary. For load/soak we'd
// re-auth periodically.
export function setup() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    fail(
      'Missing SUPABASE_URL / SUPABASE_ANON_KEY (or VITE_* equivalents). ' +
        'Source .env.local for local runs; set CI secrets for workflow runs.',
    );
  }
  if (!E2E_EMAIL || !E2E_PASSWORD) {
    fail('Missing E2E_USER_EMAIL / E2E_USER_PASSWORD. See infra/supabase/README.md.');
  }

  const loginUrl = `${SUPABASE_URL}/auth/v1/token?grant_type=password`;
  const res = http.post(loginUrl, JSON.stringify({ email: E2E_EMAIL, password: E2E_PASSWORD }), {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    tags: { endpoint: 'login' },
  });

  if (res.status !== 200) {
    fail(`Supabase login failed (${res.status}): ${res.body}`);
  }

  const body = JSON.parse(res.body);
  if (!body.access_token) {
    fail(`Supabase login response missing access_token: ${res.body}`);
  }

  return { accessToken: body.access_token };
}

export default function (data) {
  const res = http.get(`${BASE_URL}/api/me`, {
    headers: {
      Authorization: `Bearer ${data.accessToken}`,
      Accept: 'application/json',
    },
    tags: { endpoint: 'me' },
  });

  check(res, {
    '/api/me 200': (r) => r.status === 200,
    '/api/me returns email': (r) => {
      try {
        return typeof r.json('email') === 'string';
      } catch {
        return false;
      }
    },
    '/api/me returns matching email': (r) => {
      try {
        return r.json('email') === E2E_EMAIL;
      } catch {
        return false;
      }
    },
  });

  sleep(1);
}
