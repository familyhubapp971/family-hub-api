// Shared k6 helpers. Imported from scenarios/.
// Auth + per-tenant seeding lands here once Supabase + test-utils ship
// (FHS-184, FHS-187, FHS-191). For now the helpers cover anonymous
// requests against /health and /hello.

import http from 'k6/http';
import { check, group } from 'k6';
import { BASE_URL, TENANTS } from '../config.js';

export function apiGet(path, params = {}) {
  const url = `${BASE_URL}${path}`;
  return http.get(url, params);
}

export function apiPost(path, body, params = {}) {
  const url = `${BASE_URL}${path}`;
  // Spread caller headers so they don't silently clobber Content-Type.
  const headers = { 'Content-Type': 'application/json', ...(params.headers ?? {}) };
  return http.post(url, JSON.stringify(body), { ...params, headers });
}

// Per-request status check. Latency is asserted at the threshold level
// (config.js THRESHOLDS) — single source of truth for "what counts as
// slow", per FHS-153 self-review follow-up.
export function checkResponse(res, label, expectedStatus = 200) {
  return check(res, {
    [`${label} status is ${expectedStatus}`]: (r) => r.status === expectedStatus,
  });
}

// Inline single-request latency check (fast escape valve when you
// genuinely need a per-call assertion above the global threshold).
// `maxMs` is required — caller must opt into the budget to avoid the
// "did you mean read or write SLO?" footgun.
export function checkLatency(res, label, maxMs) {
  if (typeof maxMs !== 'number') {
    throw new Error(`checkLatency: maxMs is required (use THRESHOLDS.p95_response or .p95_response_write)`);
  }
  return check(res, {
    [`${label} response time < ${maxMs}ms`]: (r) => r.timings.duration < maxMs,
  });
}

// Shared workload — the default request pattern used by every scenario.
// Centralised here so adding a new endpoint to the perf suite is a
// one-file change. FHS-184 / FHS-194 will extend this with /api/me etc.
export function defaultWorkload(tenant) {
  const params = { ...withTenantHeader(tenant), tags: { tenant } };
  group('Health (no tenant)', () => {
    const res = apiGet('/health');
    checkResponse(res, 'health');
  });
  group(`Hello (tenant=${tenant})`, () => {
    const res = apiGet('/hello', params);
    checkResponse(res, 'hello');
  });
}

// Pick a synthetic tenant slug for this VU. Used by per-tenant load
// scenarios to spread VUs across tenants and validate RLS overhead.
export function tenantSlugForVU(vuId) {
  return TENANTS[vuId % TENANTS.length];
}

// Returns the headers needed to address a tenant. Today this maps to a
// plain x-tenant-id header; once Supabase JWTs land (FHS-191) this will
// generate signed tokens encoding the tenant.
export function withTenantHeader(tenantSlug) {
  return {
    headers: { 'x-tenant-id': tenantSlug },
  };
}

// Placeholder login() — wired in FHS-197 once Supabase Auth is live.
// Returns null today so scenarios can branch on auth-required paths.
export function login() {
  return null;
}
