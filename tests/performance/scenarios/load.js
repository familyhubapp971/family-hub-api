// Load scenario — sustained traffic at expected peak. 50 VUs / 5m.
// Runs nightly against staging via FHS-185 perf.yml workflow.
//
// Run locally:
//   k6 run tests/performance/scenarios/load.js
// Override target:
//   k6 run -e BASE_URL=https://api.familyhub.app tests/performance/scenarios/load.js

import { sleep } from 'k6';
import { PROFILES, THRESHOLDS, TENANTS } from '../config.js';
import { defaultWorkload, tenantSlugForVU } from '../scripts/helpers.js';
export { handleSummary } from '../scripts/report.js';

// Per-tenant threshold canary — every synthetic tenant gets its own
// p95 budget so a single tenant degrading silently is impossible.
// 1.5× the global p95 absorbs expected RLS overhead under load.
const perTenantThresholds = Object.fromEntries(
  TENANTS.map((t) => [
    `http_req_duration{tenant:${t}}`,
    [`p(95)<${THRESHOLDS.p95_response * 1.5}`],
  ]),
);

export const options = {
  vus: PROFILES.load.vus,
  duration: PROFILES.load.duration,
  thresholds: {
    http_req_duration: [`p(95)<${THRESHOLDS.p95_response}`],
    http_req_failed: [`rate<${THRESHOLDS.max_error_rate}`],
    ...perTenantThresholds,
  },
};

export default function () {
  // 50 VUs round-robin across 3 tenants → 17/17/16 split. Comment so
  // future maintainers don't read the uneven split as a bug.
  const tenant = tenantSlugForVU(__VU);
  defaultWorkload(tenant);

  // 1s think-time keeps each VU at ~1 req/s; 50 VUs ~ 50 req/s sustained.
  sleep(1);
}
