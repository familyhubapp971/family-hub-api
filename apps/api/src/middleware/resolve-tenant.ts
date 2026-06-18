import type { MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { tenants } from '../db/schema.js';
import { createLogger } from '../logger.js';

// FHS-13 + FHS-249 — resolveTenant middleware.
//
// Sets c.var.tenantId / c.var.tenantSlug from one of four sources, in
// precedence order:
//   1. JWT custom claim (app_metadata.tenant_slug) — fastest, no DB hit
//      required to choose; we still verify the slug exists below.
//   2. Subdomain — Host = `<slug>.<BASE_DOMAIN>`. Skipped when
//      BASE_DOMAIN is `localhost` because local dev never uses subdomains.
//   3. `X-Tenant-Slug` request header — the SPA's hint when its
//      route lives at `/t/<slug>/...` but the API call goes to a
//      tenant-agnostic path like `/api/onboarding/complete`. Same
//      validation as every other source (SLUG_RE before DB lookup).
//   4. Path prefix — request path begins with `/t/<slug>/`. This is the
//      interim mechanism (see ADR 0012) until we own a real domain.
//
// On miss the context vars stay undefined. Public routes that don't
// need a tenant (e.g. /api/public/slug-available) work either way;
// protected routes that DO require a tenant should reject the request
// in their own handlers (or via a future requireTenant middleware).

const log = createLogger('resolve-tenant');

// Subdomains that aren't tenants — skip the DB lookup. Keep this list
// in sync with anything we serve under <name>.<BASE_DOMAIN> that isn't
// a customer family.
const RESERVED_SUBDOMAINS = new Set([
  'www',
  'api',
  'app',
  'admin',
  'docs',
  'staging',
  'production',
]);

// Slug syntax rules — match the tenants table constraint. Lowercase
// alphanumeric with optional internal hyphens, 1–63 chars (DNS label
// cap). Used to validate every slug source BEFORE we hit the DB so a
// forged Host header / hostile JWT claim / typo in the URL doesn't
// trigger an indexed lookup or pass an unexpected value downstream.
//
// Slug uniqueness AND reservation (no `admin`, `www`, etc.) are
// enforced at signup time by `slug-available` (FHS-27) and
// `POST /api/public/tenant` (FHS-25). The middleware doesn't re-check
// reservations because they cannot exist in the table.
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Extract `<slug>` from `/t/<slug>/...`. Anchored at the path root so
// `/api/t/.../...` never accidentally matches. Slug shape is double-
// checked via SLUG_RE before lookup for defence in depth.
const PATH_SLUG_RE = /^\/t\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\/|$)/;

export interface ResolveTenantOptions {
  // Returns the tenant uuid for a slug, or undefined when no row matches.
  // Production wires this to `makeDbLookup(getDb())`; tests pass a stub
  // so they don't need a live pool.
  lookupTenantId: (slug: string) => Promise<string | undefined>;
  // Override BASE_DOMAIN for tests; defaults to config.BASE_DOMAIN.
  baseDomain?: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    tenantSlug: string | undefined;
  }
}

// Production-wired lookup. Single indexed query per request — caching
// is a follow-up once hot-path measurements warrant it. The `db` arg is
// typed loosely so this file doesn't need to know whether the caller
// passed a real Drizzle instance or a transactional one.
export function makeDbLookup(
  // Lazy getter, not a captured instance — avoids pinning a build-time db.
  // Tenant resolution runs before any request-scoped client and queries the
  // global `tenants` registry (not RLS-scoped), so this resolves to the root
  // pool; the getter just keeps it from going stale if the pool is recreated.
  getDb: () => import('../db/client.js').Database,
): (slug: string) => Promise<string | undefined> {
  return async (slug) => {
    try {
      const rows = await getDb()
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .limit(1);
      return rows[0]?.id;
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), slug },
        'tenant lookup failed',
      );
      return undefined;
    }
  };
}

export function resolveTenant(opts: ResolveTenantOptions): MiddlewareHandler {
  const baseDomain = opts.baseDomain ?? config.BASE_DOMAIN;

  return async (c, next) => {
    // Try every candidate slug source in priority order until one
    // actually resolves to a tenant. The earlier "first non-empty
    // source wins" behaviour fell apart on Railway-style hosts where
    // the API's own host (e.g. `api-staging-5500.up.railway.app`) is
    // a valid slug-shaped string under the shared `.up.railway.app`
    // suffix: subdomain source picked `api-staging-5500`, lookup
    // failed, and the SPA-supplied `x-tenant-slug` header was never
    // consulted — every authenticated tenant call 400'd with
    // "tenant context required".
    const candidates = pickSlugCandidates(c, baseDomain);
    for (const slug of candidates) {
      const tenantId = await opts.lookupTenantId(slug);
      if (tenantId) {
        c.set('tenantId', tenantId);
        c.set('tenantSlug', slug);
        return next();
      }
    }
    if (candidates.length > 0) {
      // Every candidate failed lookup. Debug-only so /t/<garbage>/
      // probes can't fill the logs.
      log.debug({ candidates }, 'resolveTenant: no candidate slug matched a tenant row');
    }

    await next();
  };
}

function pickSlugCandidates(c: Parameters<MiddlewareHandler>[0], baseDomain: string): string[] {
  // Collect every slug-shaped candidate in priority order. Validate
  // each against SLUG_RE here so the middleware loop can issue DB
  // lookups blindly without re-checking. De-dup at the end so a host
  // header echoing the path prefix doesn't double the lookup cost.
  const out: string[] = [];

  // Source 1 — JWT custom claim app_metadata.tenant_slug.
  const user = c.get('user');
  if (user?.claims) {
    const meta = user.claims['app_metadata'] as Record<string, unknown> | undefined;
    const fromClaim = typeof meta?.['tenant_slug'] === 'string' ? meta['tenant_slug'] : undefined;
    if (fromClaim && SLUG_RE.test(fromClaim)) out.push(fromClaim);
  }

  // Source 2 — subdomain. Strip an optional port (`:3001`) before
  // splitting; treat `BASE_DOMAIN === 'localhost'` as "no subdomain
  // routing" (local dev served at http://localhost:5273 has no slug).
  // Validate the candidate against SLUG_RE so a forged Host header
  // (`'A'.repeat(500).familyhub.app`) can't trigger a DB lookup.
  if (baseDomain !== 'localhost') {
    const rawHost = c.req.header('host') ?? '';
    const host = rawHost.split(':')[0] ?? '';
    const suffix = `.${baseDomain}`;
    if (host.endsWith(suffix)) {
      const candidate = host.slice(0, -suffix.length);
      if (
        candidate &&
        !candidate.includes('.') &&
        !RESERVED_SUBDOMAINS.has(candidate) &&
        SLUG_RE.test(candidate)
      ) {
        out.push(candidate);
      }
    }
  }

  // Source 3 — `X-Tenant-Slug` request header. Set by the SPA when
  // it's calling a tenant-agnostic API path from inside a /t/:slug/*
  // route (e.g. POST /api/onboarding/complete from the wizard).
  const headerSlug = c.req.header('x-tenant-slug')?.trim();
  if (headerSlug && SLUG_RE.test(headerSlug)) out.push(headerSlug);

  // Source 4 — path prefix /t/<slug>/...
  const m = PATH_SLUG_RE.exec(c.req.path);
  if (m && m[1] && SLUG_RE.test(m[1])) out.push(m[1]);

  return [...new Set(out)];
}
