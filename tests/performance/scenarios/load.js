// Load scenario — sustained traffic at expected peak. 50 VUs / 5m.
// Runs nightly against staging via FHS-185 perf.yml workflow.
//
// FHS-460 — see config.js's RATE-LIMIT WARNING block before pointing
// this at staging: 50 VUs x ~19 requests/session will blow through the
// default 100 req/min bucket in seconds unless the limit is raised for
// the test window.
//
// Run locally (after seeding — see tests/performance/README.md):
//   node tests/performance/bin/seed-load-tenants.mjs
//   k6 run -e LOAD_FIXTURES=tests/performance/fixtures/load-tenants.json \
//          tests/performance/scenarios/load.js
// Override target:
//   k6 run -e BASE_URL=https://api.familyhub.app -e LOAD_FIXTURES=... \
//          tests/performance/scenarios/load.js

import { sleep } from 'k6';
import { BASE_URL, PROFILES, THRESHOLDS, hotScreenThresholds } from '../config.js';
import { kidSession, parentSession, healthOnlyFallback } from '../lib/helpers.js';
import { loadFixtures, loginAllFixtures } from '../lib/fixtures.js';
export { handleSummary } from '../lib/report.js';

export const options = {
  vus: PROFILES.load.vus,
  duration: PROFILES.load.duration,
  thresholds: {
    http_req_duration: [`p(95)<${THRESHOLDS.p95_response}`],
    http_req_failed: [`rate<${THRESHOLDS.max_error_rate}`],
    ...hotScreenThresholds(),
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
  // Round-robin VUs across the seeded fixtures (and their kids) so load
  // spreads across every synthetic tenant instead of hammering one.
  const fixture = data.fixtures[(__VU - 1) % data.fixtures.length];
  const kid = fixture.kids[__VU % fixture.kids.length];
  kidSession(BASE_URL, kid.token);
  if (fixture.parent.token) {
    parentSession(BASE_URL, fixture.parent.token, fixture.tenantSlug, kid.memberId);
  }

  // 1s think-time keeps each VU at ~1 session/s.
  sleep(1);
}
