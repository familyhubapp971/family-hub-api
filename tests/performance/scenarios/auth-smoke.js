// FHS-197: k6 auth-smoke scenario.
//
// Logs in once with a password through the api's /auth/v1 (in setup()), then hammers
// GET /api/me with the bearer token for 30 s. Records p95 baseline so
// regressions on the protected request path show up early.
//
// Run locally:
//   set -a; source .env.local; set +a
//   k6 run tests/performance/scenarios/auth-smoke.js
//
// Override target API:
//   k6 run -e BASE_URL=https://fh-api-staging.up.railway.app \
//          tests/performance/scenarios/auth-smoke.js
//
// Required env vars (from .env.local for local; CI secrets for runs):
//   BASE_URL                : api origin (default: http://localhost:3001)
//   AUTH_URL                : api whose /auth/v1 signs in (default: BASE_URL)
//   E2E_USER_EMAIL          : synthetic e2e user email
//   E2E_USER_PASSWORD       : synthetic e2e user password

import http from 'k6/http';
import { check, sleep, fail } from 'k6';
import { BASE_URL, PROFILES, THRESHOLDS } from '../config.js';
export { handleSummary } from '../lib/report.js';

const AUTH_URL = __ENV.AUTH_URL || BASE_URL;
const E2E_EMAIL = __ENV.E2E_USER_EMAIL;
const E2E_PASSWORD = __ENV.E2E_USER_PASSWORD;

export const options = {
  vus: PROFILES.smoke.vus,
  duration: PROFILES.smoke.duration,
  thresholds: {
    // Tag-scoped: only /api/me requests count against the read-budget,
    // so the login round-trip in setup() doesn't skew the result.
    'http_req_duration{endpoint:me}': [`p(95)<${THRESHOLDS.p95_response}`],
    'http_req_failed{endpoint:me}': [`rate<${THRESHOLDS.max_error_rate_smoke}`],
  },
};

// One-shot login. setup() runs once before the test starts; its return
// value is passed to every default() iteration. 1 token → N requests.
// Trade-off: token expiry (1h) > smoke duration (30s), so
// token refresh inside the loop is unnecessary. For load/soak we'd
// re-auth periodically.
export function setup() {
  if (!E2E_EMAIL || !E2E_PASSWORD) {
    fail('Missing E2E_USER_EMAIL / E2E_USER_PASSWORD (the staging browser-test account).');
  }

  const loginUrl = `${AUTH_URL}/auth/v1/token?grant_type=password`;
  const res = http.post(loginUrl, JSON.stringify({ email: E2E_EMAIL, password: E2E_PASSWORD }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { endpoint: 'login' },
  });

  if (res.status !== 200) {
    fail(`Password sign-in failed (${res.status}): ${res.body}`);
  }

  const body = JSON.parse(res.body);
  if (!body.access_token) {
    fail(`Sign-in response missing access_token: ${res.body}`);
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
