// Smoke scenario — 30s, 1 VU. Quick sanity check that real authenticated
// family sessions (kid + parent) still work end to end. Runs every PR
// after integration.
//
// FHS-460 — logs in once in setup() against seeded synthetic load-test
// fixtures, then runs one kid session (+ one parent session when a
// parent token is available) per iteration. Falls back to a health-only
// ping (with a loud console.warn) when no fixtures are configured, so
// the scenario still runs in CI instead of failing outright — but that
// fallback is NOT a real test; see tests/performance/README.md.
//
// Run locally (after seeding — see tests/performance/README.md):
//   node tests/performance/scripts/seed-load-tenants.mjs
//   k6 run -e LOAD_FIXTURES=tests/performance/fixtures/load-tenants.json \
//          tests/performance/scenarios/smoke.js
// Health-only fallback (no seeding — NOT a real capacity test):
//   k6 run tests/performance/scenarios/smoke.js
// Override target:
//   k6 run -e BASE_URL=https://staging.familyhub.app -e LOAD_FIXTURES=... \
//          tests/performance/scenarios/smoke.js

import { sleep } from 'k6';
import { BASE_URL, PROFILES, THRESHOLDS } from '../config.js';
import { kidSession, parentSession, healthOnlyFallback } from '../scripts/helpers.js';
import { loadFixtures, loginAllFixtures } from '../scripts/fixtures.js';
export { handleSummary } from '../scripts/report.js';

export const options = {
  vus: PROFILES.smoke.vus,
  duration: PROFILES.smoke.duration,
  thresholds: {
    http_req_duration: [`p(95)<${THRESHOLDS.p95_response}`],
    http_req_failed: [`rate<${THRESHOLDS.max_error_rate_smoke}`],
  },
};

export function setup() {
  const fixtures = loadFixtures();
  if (fixtures.length === 0) return { fixtures: [] };
  return { fixtures: loginAllFixtures(BASE_URL, fixtures) };
}

export default function (data) {
  if (data.fixtures.length === 0) {
    healthOnlyFallback();
    sleep(1);
    return;
  }
  // Single VU rotates through fixtures + kids by iteration so even a
  // 1-VU smoke run exercises every seeded tenant across a full run.
  const fixture = data.fixtures[__ITER % data.fixtures.length];
  const kid = fixture.kids[__ITER % fixture.kids.length];
  kidSession(BASE_URL, kid.token);
  if (fixture.parent.token) {
    parentSession(BASE_URL, fixture.parent.token, fixture.tenantSlug, kid.memberId);
  }
  sleep(1);
}
