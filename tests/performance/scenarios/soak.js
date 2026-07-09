// Soak scenario — sustained moderate load for hours to surface memory
// leaks, connection-pool exhaustion, GC pressure, log-volume issues.
// 30 VUs / 2h. Runs weekly Sunday nightly via FHS-185 perf.yml.
//
// FHS-460 — see config.js's RATE-LIMIT WARNING block before pointing
// this at staging; 30 VUs of real sessions still needs the limit raised
// for the run to measure real latency instead of 429s.
//
// Run locally (long! — usually only run in CI):
//   node tests/performance/bin/seed-load-tenants.mjs
//   k6 run -e LOAD_FIXTURES=tests/performance/fixtures/load-tenants.json \
//          tests/performance/scenarios/soak.js

import { sleep } from 'k6';
import { BASE_URL, PROFILES, THRESHOLDS } from '../config.js';
import { kidSession, parentSession, healthOnlyFallback } from '../lib/helpers.js';
import { loadFixtures, loginAllFixtures } from '../lib/fixtures.js';
export { handleSummary } from '../lib/report.js';

export const options = {
  vus: PROFILES.soak.vus,
  duration: PROFILES.soak.duration,
  thresholds: {
    // p95 normal + p99 drift detection. Combined into one array because
    // a duplicate `http_req_duration` key would silently overwrite
    // (JS object literal semantics). p99 uses its dedicated
    // THRESHOLDS.p99_response — independent of the write SLO.
    http_req_duration: [`p(95)<${THRESHOLDS.p95_response}`, `p(99)<${THRESHOLDS.p99_response}`],
    http_req_failed: [`rate<${THRESHOLDS.max_error_rate}`],
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
    sleep(2 + Math.random() * 3);
    return;
  }
  const fixture = data.fixtures[(__VU - 1) % data.fixtures.length];
  const kid = fixture.kids[__VU % fixture.kids.length];
  kidSession(BASE_URL, kid.token);
  if (fixture.parent.token) {
    parentSession(BASE_URL, fixture.parent.token, fixture.tenantSlug, kid.memberId);
  }

  // Uniform [2, 5)s think-time — not modelled on a real distribution,
  // but enough variance to avoid lock-step VU behaviour over the soak.
  sleep(2 + Math.random() * 3);
}
