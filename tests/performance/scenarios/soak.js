// Soak scenario — sustained moderate load for hours to surface memory
// leaks, connection-pool exhaustion, GC pressure, log-volume issues.
// 30 VUs / 2h. Runs weekly Sunday nightly via FHS-185 perf.yml.
//
// Run locally (long! — usually only run in CI):
//   k6 run tests/performance/scenarios/soak.js

import { sleep } from 'k6';
import { PROFILES, THRESHOLDS } from '../config.js';
import { defaultWorkload, tenantSlugForVU } from '../scripts/helpers.js';
export { handleSummary } from '../scripts/report.js';

export const options = {
  vus: PROFILES.soak.vus,
  duration: PROFILES.soak.duration,
  thresholds: {
    // p95 normal + p99 drift detection. Combined into one array because
    // a duplicate `http_req_duration` key would silently overwrite
    // (JS object literal semantics). p99 uses its dedicated
    // THRESHOLDS.p99_response — independent of the write SLO.
    http_req_duration: [
      `p(95)<${THRESHOLDS.p95_response}`,
      `p(99)<${THRESHOLDS.p99_response}`,
    ],
    http_req_failed: [`rate<${THRESHOLDS.max_error_rate}`],
  },
};

export default function () {
  const tenant = tenantSlugForVU(__VU);
  defaultWorkload(tenant);

  // Uniform [2, 5)s think-time — not modelled on a real distribution,
  // but enough variance to avoid lock-step VU behaviour over the soak.
  sleep(2 + Math.random() * 3);
}
