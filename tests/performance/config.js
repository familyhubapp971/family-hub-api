// k6 shared config — VU profiles and thresholds.
// Thresholds are tied to documents/technical/slos.md (FHS — TBD ticket).
//
// k6 hits the API origin directly (not the web dev proxy). Locally the
// api dev server runs on :3001. In CI/staging override BASE_URL:
//   k6 run -e BASE_URL=https://api.familyhub.app scenarios/smoke.js

// ─────────────────────────────────────────────────────────────────────────
// ⚠️  RATE-LIMIT WARNING — read this before running load/stress/soak.
// ─────────────────────────────────────────────────────────────────────────
// apps/api/src/middleware/rate-limit.ts caps every caller at
// RATE_LIMIT_PER_MINUTE requests per 60s (config.ts default: 100),
// keyed on the CALLER'S IP (apps/api/src/app.ts mounts it globally,
// before auth, for every request).
//
// k6 sends ALL of a run's traffic from ONE machine → ONE IP → ONE shared
// token bucket, no matter how many VUs you spin up. A single realistic
// family session (see scripts/helpers.js kidSession/parentSession) is
// ~12-19 requests. At the `load` profile (50 VUs) that's up to
// 50 x 19 = 950 requests in the first minute — you will exhaust the
// 100-token bucket in a few seconds and spend the rest of the run
// measuring 429 "rate limit exceeded" responses, not real API latency.
//
// Before pointing load/stress/soak at staging, EITHER:
//   1. Ask for RATE_LIMIT_PER_MINUTE to be raised on the staging Railway
//      service for the test window (and set back after), OR
//   2. Keep VUs low enough that (VUs x ~19 req) stays under the limit —
//      fine for `smoke` (1 VU), but defeats the point of `load`/`stress`.
// A run that's mostly 429s is a rate-limit ceiling finding, not a real
// capacity finding — don't report it as the latter.
// ─────────────────────────────────────────────────────────────────────────

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';

export const PROFILES = {
  smoke: { vus: 1, duration: '30s' },
  load: { vus: 50, duration: '5m' },
  stress: { vus: 200, duration: '10m' },
  soak: { vus: 30, duration: '2h' },
};

// Working SLO targets until documents/technical/slos.md is authored (FHS-167).
// Smoke tolerates a higher error rate than load/stress because a
// 30s/1VU run with rate<0.01 fails on a single transient blip (1/30 = 3.3%).
export const THRESHOLDS = {
  p95_response: 250, // ms — read endpoints (steady-state)
  p95_response_write: 500, // ms — write endpoints (steady-state)
  p99_response: 500, // ms — soak drift detection (named separately so
  //                          FHS-167 can change p99 independently)
  max_error_rate: 0.01, // 1% max for load/soak
  max_error_rate_smoke: 0.05, // 5% for smoke (allows 1 transient miss)
};

// Stress is deliberately past peak — looser thresholds. Named multipliers
// so FHS-167 can adjust without hunting `* 2` magic numbers in scenarios.
export const STRESS_LATENCY_MULTIPLIER = 2;
export const STRESS_ERROR_BUDGET_MULTIPLIER = 2;

// FHS-460 — the two screens every real session opens (the parent
// Dashboard/Today tab and the kid Today tab) get their OWN p95 budget
// tag instead of hiding inside the global average. scripts/helpers.js
// tags those two requests `name:dashboard` / `name:kid-today`.
// `multiplier` lets stress.js reuse this with STRESS_LATENCY_MULTIPLIER
// instead of duplicating the threshold strings.
export function hotScreenThresholds(multiplier = 1) {
  const budget = THRESHOLDS.p95_response * multiplier;
  return {
    'http_req_duration{name:dashboard}': [`p(95)<${budget}`],
    'http_req_duration{name:kid-today}': [`p(95)<${budget}`],
  };
}
