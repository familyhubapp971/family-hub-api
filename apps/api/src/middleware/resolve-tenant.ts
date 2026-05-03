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
  db: import('../db/client.js').Database,
): (slug: string) => Promise<string | undefined> {
  return async (slug) => {
    try {
      const rows = await db
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
    const slug = pickSlug(c, baseDomain);

    if (slug && SLUG_RE.test(slug)) {
      const tenantId = await opts.lookupTenantId(slug);
      if (tenantId) {
        c.set('tenantId', tenantId);
        c.set('tenantSlug', slug);
      } else {
        // Slug parsed cleanly but no matching row — tenant offboarded
        // or typo. Leave context vars unset; callers that require a
        // tenant will respond with the appropriate 404. Debug-level so
        // a bot scanning random `/t/<garbage>/` paths can't fill the
        // logs.
        log.debug({ slug }, 'resolveTenant: slug parsed but no matching tenant row');
      }
    }

    await next();
  };
}

function pickSlug(c: Parameters<MiddlewareHandler>[0], baseDomain: string): string | undefined {
  // Source 1 — JWT custom claim app_metadata.tenant_slug.
  const user = c.get('user');
  if (user?.claims) {
    const meta = user.claims['app_metadata'] as Record<string, unknown> | undefined;
    const fromClaim = typeof meta?.['tenant_slug'] === 'string' ? meta['tenant_slug'] : undefined;
    if (fromClaim) return fromClaim;
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
        return candidate;
      }
    }
  }

  // Source 3 — `X-Tenant-Slug` request header. Set by the SPA when
  // it's calling a tenant-agnostic API path from inside a /t/:slug/*
  // route (e.g. POST /api/onboarding/complete from the wizard). The
  // same SLUG_RE gate at the call site prevents a forged value from
  // reaching the DB lookup.
  const headerSlug = c.req.header('x-tenant-slug')?.trim();
  if (headerSlug) return headerSlug;

  // Source 4 — path prefix /t/<slug>/...
  const m = PATH_SLUG_RE.exec(c.req.path);
  if (m && m[1]) return m[1];

  return undefined;
}
