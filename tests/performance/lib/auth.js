// FHS-460: login helpers for k6 scenarios that need REAL authenticated
// sessions instead of anonymous /health + /hello pings.
//
// kidLogin    : POST /api/auth/kid-pin (apps/api/src/routes/auth-kid-pin.ts).
//               Family-shared-device PIN login. Returns a short-lived
//               HS256 JWT with the tenant baked into the token claims:
//               kid requests to /api/kid/* send ONLY the bearer token,
//               never an X-Tenant-Slug header.
// parentLogin : Supabase password grant. Same call
//               scenarios/auth-smoke.js already makes (mirrored here so
//               every scenario logs parents in the same way). Parent
//               requests DO need an X-Tenant-Slug header alongside the
//               bearer token, because k6 hits the API origin directly
//               (no `<slug>.familyhub.app` subdomain routing), see
//               apps/api/src/middleware/resolve-tenant.ts source 3.

import http from 'k6/http';
import { check, fail } from 'k6';

/**
 * @param {string} baseUrl - API origin, e.g. config.BASE_URL.
 * @param {{tenantSlug: string, memberId: string, pin: string}} creds
 * @returns {string} the kid-scoped bearer token.
 */
export function kidLogin(baseUrl, { tenantSlug, memberId, pin }) {
  const res = http.post(
    `${baseUrl}/api/auth/kid-pin`,
    JSON.stringify({ tenantSlug, memberId, pin }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'kid-login' } },
  );
  check(res, { 'kid login 200': (r) => r.status === 200 });
  if (res.status !== 200) {
    fail(`kidLogin failed for tenant=${tenantSlug} member=${memberId}: ${res.status} ${res.body}`);
  }
  return res.json().token;
}

/**
 * @param {string} supabaseUrl - e.g. https://<project>.supabase.co
 * @param {string} anonKey - Supabase publishable/anon key.
 * @param {{email: string, password: string}} creds
 * @returns {string} the parent's Supabase access_token.
 */
export function parentLogin(supabaseUrl, anonKey, { email, password }) {
  const res = http.post(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    JSON.stringify({ email, password }),
    {
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      tags: { name: 'parent-login' },
    },
  );
  check(res, { 'parent login 200': (r) => r.status === 200 });
  if (res.status !== 200) {
    fail(`parentLogin failed for ${email}: ${res.status} ${res.body}`);
  }
  return res.json().access_token;
}
