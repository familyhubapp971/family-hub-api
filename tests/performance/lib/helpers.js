// Shared k6 helpers. Imported from scenarios/.
//
// FHS-460: replaced the old anonymous-only workload (which only ever hit
// /health + /hello, and whose tenant helper sent a header
// (`x-tenant-id`) that resolve-tenant.ts doesn't even read) with two
// REAL, authenticated family sessions: kidSession() and parentSession().
// See scripts/auth.js for how the tokens they need are minted, and
// scripts/fixtures.js for how a scenario's setup() logs everyone in once.

import http from 'k6/http';
import { check, group } from 'k6';
import { BASE_URL } from '../config.js';

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
// (config.js THRESHOLDS): single source of truth for "what counts as
// slow", per FHS-153 self-review follow-up.
export function checkResponse(res, label, expectedStatus = 200) {
  return check(res, {
    [`${label} status is ${expectedStatus}`]: (r) => r.status === expectedStatus,
  });
}

// Inline single-request latency check (fast escape valve when you
// genuinely need a per-call assertion above the global threshold).
// `maxMs` is required: caller must opt into the budget to avoid the
// "did you mean read or write SLO?" footgun.
export function checkLatency(res, label, maxMs) {
  if (typeof maxMs !== 'number') {
    throw new Error(
      `checkLatency: maxMs is required (use THRESHOLDS.p95_response or .p95_response_write)`,
    );
  }
  return check(res, {
    [`${label} response time < ${maxMs}ms`]: (r) => r.timings.duration < maxMs,
  });
}

// Monday (UTC) of the week containing `date`, as YYYY-MM-DD: mirrors
// apps/api/src/lib/myworld.ts mondayOf() exactly, so ?weekStart matches
// what a real browser client would send for "this week".
export function mondayOf(date) {
  const day = date.getUTCDay(); // 0=Sun..6=Sat
  const shift = day === 0 ? -6 : 1 - day;
  const monday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + shift),
  );
  return monday.toISOString().slice(0, 10);
}

function kidGet(baseUrl, kidToken, path, extraTags) {
  return http.get(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${kidToken}` },
    tags: { workload: 'kid', ...extraTags },
  });
}

function parentGet(baseUrl, token, tenantSlug, path, extraTags) {
  return http.get(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Tenant-Slug': tenantSlug },
    tags: { workload: 'parent', ...extraTags },
  });
}

// FHS-460, the kid ChildWorld session: every GET the kid dashboard makes
// on open (apps/api/src/routes/kid.ts), in the order a real kid session
// hits them. 12 requests. /today is the kid's landing screen, tagged
// `name:kid-today` so config.js hotScreenThresholds() can budget it
// separately from the rest.
export function kidSession(baseUrl, kidToken) {
  const weekStart = mondayOf(new Date());
  group('kid session', () => {
    checkResponse(kidGet(baseUrl, kidToken, '/api/kid/me'), 'kid /me');
    checkResponse(kidGet(baseUrl, kidToken, '/api/kid/profile'), 'kid /profile');
    checkResponse(kidGet(baseUrl, kidToken, '/api/kid/today', { name: 'kid-today' }), 'kid /today');
    checkResponse(kidGet(baseUrl, kidToken, '/api/kid/tasks'), 'kid /tasks');
    checkResponse(
      kidGet(baseUrl, kidToken, `/api/kid/events?weekStart=${weekStart}`),
      'kid /events',
    );
    checkResponse(kidGet(baseUrl, kidToken, '/api/kid/meals'), 'kid /meals');
    checkResponse(kidGet(baseUrl, kidToken, '/api/kid/habits'), 'kid /habits');
    checkResponse(kidGet(baseUrl, kidToken, '/api/kid/weeks'), 'kid /weeks');
    checkResponse(
      kidGet(baseUrl, kidToken, '/api/kid/financial/savings'),
      'kid /financial/savings',
    );
    checkResponse(
      kidGet(baseUrl, kidToken, '/api/kid/financial/investments'),
      'kid /financial/investments',
    );
    checkResponse(kidGet(baseUrl, kidToken, '/api/kid/rewards'), 'kid /rewards');
    checkResponse(kidGet(baseUrl, kidToken, '/api/kid/learn'), 'kid /learn');
  });
}

// FHS-460, the parent dashboard session: every GET the parent Today tab
// + its sibling tabs make on open. 7 requests. /dashboard/today is the
// parent's landing screen, tagged `name:dashboard`. Parent calls need
// BOTH the Supabase bearer token AND X-Tenant-Slug (see scripts/auth.js
// header comment for why). `kidMemberId` scopes the habits read to one
// child, same as the My World tab does for whichever kid card is open.
export function parentSession(baseUrl, token, tenantSlug, kidMemberId) {
  const weekStart = mondayOf(new Date());
  group('parent session', () => {
    checkResponse(parentGet(baseUrl, token, tenantSlug, '/api/me'), 'parent /me');
    checkResponse(
      parentGet(baseUrl, token, tenantSlug, '/api/dashboard/today', { name: 'dashboard' }),
      'parent /dashboard/today',
    );
    checkResponse(parentGet(baseUrl, token, tenantSlug, '/api/members'), 'parent /members');
    checkResponse(
      parentGet(baseUrl, token, tenantSlug, `/api/events?weekStart=${weekStart}`),
      'parent /events',
    );
    checkResponse(parentGet(baseUrl, token, tenantSlug, '/api/tasks'), 'parent /tasks');
    checkResponse(parentGet(baseUrl, token, tenantSlug, '/api/meals'), 'parent /meals');
    checkResponse(
      parentGet(baseUrl, token, tenantSlug, `/api/habits?memberId=${kidMemberId}`),
      'parent /habits',
    );
  });
}

// FHS-460: fallback workload used ONLY when LOAD_FIXTURES isn't set
// (see scripts/fixtures.js). Keeps the scenario runnable (and the CI
// wiring intact) without pretending an anonymous /health ping is a real
// capacity test: loadFixtures() already warns loudly about this.
export function healthOnlyFallback() {
  group('Health only (LOAD_FIXTURES not set, not a real capacity test)', () => {
    checkResponse(apiGet('/health'), 'health');
  });
}
