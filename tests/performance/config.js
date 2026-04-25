// k6 shared config — VU profiles and thresholds.
// Thresholds are tied to docs/technical/slos.md (FHS — TBD ticket).
//
// k6 hits the API origin directly (not the web dev proxy). Locally the
// api dev server runs on :3001. In CI/staging override BASE_URL:
//   k6 run -e BASE_URL=https://api.familyhub.app scenarios/smoke.js

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';

export const PROFILES = {
  smoke: { vus: 1, duration: '30s' },
  load: { vus: 50, duration: '5m' },
  stress: { vus: 200, duration: '10m' },
  soak: { vus: 30, duration: '2h' },
};

// Working SLO targets until docs/technical/slos.md is authored (FHS-167).
// Smoke tolerates a higher error rate than load/stress because a
// 30s/1VU run with rate<0.01 fails on a single transient blip (1/30 = 3.3%).
export const THRESHOLDS = {
  p95_response: 250, // ms — read endpoints
  p95_response_write: 500, // ms — write endpoints
  max_error_rate: 0.01, // 1% max for load/stress/soak
  max_error_rate_smoke: 0.05, // 5% for smoke (allows 1 transient miss)
};

// Synthetic tenant slugs for per-tenant VU groups (FHS-184 will provide
// real factories; until then these are placeholders matched by the
// integration test seeds).
export const TENANTS = ['tenant-a', 'tenant-b', 'tenant-c'];
