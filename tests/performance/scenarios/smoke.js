// Smoke scenario — 30s, 1 VU. Quick sanity check that the API is alive
// and returning healthy responses. Runs every PR after integration.
//
// Run locally:
//   k6 run tests/performance/scenarios/smoke.js
// Override target:
//   k6 run -e BASE_URL=https://staging.familyhub.app tests/performance/scenarios/smoke.js

import { sleep } from 'k6';
import { PROFILES, THRESHOLDS, TENANTS } from '../config.js';
import { defaultWorkload } from '../scripts/helpers.js';
export { handleSummary } from '../scripts/report.js';

export const options = {
  vus: PROFILES.smoke.vus,
  duration: PROFILES.smoke.duration,
  thresholds: {
    http_req_duration: [`p(95)<${THRESHOLDS.p95_response}`],
    http_req_failed: [`rate<${THRESHOLDS.max_error_rate_smoke}`],
  },
};

export default function () {
  // Single VU rotates through tenants by iteration so the smoke
  // exercises the per-tenant code path even with vus=1.
  const tenant = TENANTS[__ITER % TENANTS.length];
  defaultWorkload(tenant);
  sleep(1);
}
