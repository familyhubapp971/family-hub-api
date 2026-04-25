// Shared k6 helpers. Imported from scenarios/.
// Auth + per-tenant seeding lands here once Supabase + test-utils ship
// (FHS-184, FHS-187, FHS-191). For now the helpers cover anonymous
// requests against /health and /hello.

import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, TENANTS } from '../config.js';

export function apiGet(path, params = {}) {
  const url = `${BASE_URL}${path}`;
  return http.get(url, params);
}

export function apiPost(path, body, params = {}) {
  const url = `${BASE_URL}${path}`;
  return http.post(url, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...params,
  });
}

export function checkResponse(res, label, expectedStatus = 200) {
  return check(res, {
    [`${label} status is ${expectedStatus}`]: (r) => r.status === expectedStatus,
    [`${label} response time < 500ms`]: (r) => r.timings.duration < 500,
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
