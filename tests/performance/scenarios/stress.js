// Stress scenario — push past expected peak to find breaking point.
// Ramps from 0 → 200 VUs over 10m, then drops back. Run pre-release
// only (manual / FHS-185 perf.yml on demand).
//
// Run locally:
//   k6 run tests/performance/scenarios/stress.js

import { sleep } from 'k6';
import {
  PROFILES,
  THRESHOLDS,
  STRESS_LATENCY_MULTIPLIER,
  STRESS_ERROR_BUDGET_MULTIPLIER,
} from '../config.js';
import { defaultWorkload, tenantSlugForVU } from '../scripts/helpers.js';
export { handleSummary } from '../scripts/report.js';

const peakVUs = PROFILES.stress.vus; // 200
// max(1, round(...)) keeps stages sensible even if peakVUs is later
// lowered to a non-multiple of 4.
const stageVUs = (frac) => Math.max(1, Math.round(peakVUs * frac));

export const options = {
  // Ramp pattern: 0 → 25% → 50% → 100% → hold → 0. Total ~10m.
  stages: [
    { duration: '2m', target: stageVUs(0.25) },
    { duration: '2m', target: stageVUs(0.5) },
    { duration: '2m', target: peakVUs },
    { duration: '2m', target: peakVUs }, // hold at peak
    { duration: '2m', target: 0 }, // ramp down
  ],
  thresholds: {
    http_req_duration: [`p(95)<${THRESHOLDS.p95_response * STRESS_LATENCY_MULTIPLIER}`],
    http_req_failed: [`rate<${THRESHOLDS.max_error_rate * STRESS_ERROR_BUDGET_MULTIPLIER}`],
  },
};

export default function () {
  const tenant = tenantSlugForVU(__VU);
  defaultWorkload(tenant);

  // 100ms think-time → each VU caps at ~10 rps. The intent is high
  // throughput without melting the api in tight-loop mode; tighten
  // toward 0 if we want to push the upper bound on real hardware.
  sleep(0.1);
}
