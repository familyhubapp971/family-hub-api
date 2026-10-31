import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';
import { config } from '../config.js';

/**
 * CORS middleware bound to BASE_DOMAIN + subdomains, or to an explicit
 * comma-separated CORS_ALLOWED_ORIGINS list when set. Returns the
 * matched origin verbatim (not '*') so credentialed requests work.
 *
 * Localhost dev gets a wildcard port match so :3001 / :5273 / :6006
 * (Storybook later) all pass without explicit listing.
 */
export function corsMiddleware(): MiddlewareHandler {
  const explicit = config.CORS_ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return cors({
    origin: (origin) => {
      if (!origin) return undefined; // same-origin / curl: let it through

      // Explicit allowlist always wins.
      if (explicit.length > 0) {
        return explicit.includes(origin) ? origin : null;
      }

      // Localhost dev: any port on 127.0.0.1 / localhost, http only.
      if (config.BASE_DOMAIN === 'localhost') {
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
        return null;
      }

      // Production: BASE_DOMAIN apex + any *.subdomain. https only:
      // a misconfigured proxy or attacker-controlled origin must not
      // get a credentialed allow over plaintext.
      const escaped = config.BASE_DOMAIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^https://([a-z0-9-]+\\.)*${escaped}$`);
      return re.test(origin) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // x-tenant-slug: every tenant-scoped fetch from the web app sets this
    // (family-hub-web: the onboarding page, the members page, every dashboard
    // tab panel) and resolveTenantMiddleware reads it. Missing it from
    // Allow-Headers blocks the OPTIONS preflight on every authenticated
    // call, with the visible failure landing on whichever endpoint the
    // user hits first.
    // x-request-id: surfaced by request-context middleware; harmless to
    // accept from the client (server overrides anyway) and lets the web
    // attach a correlation id for support tickets.
    // FHS-694: apikey, x-client-info and x-supabase-api-version are sent by
    // the web app's sign-in client on every /auth/v1 call (passed through to
    // our GoTrue server). Without them the browser's preflight fails.
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'x-tenant-slug',
      'x-request-id',
      'x-founder-token',
      'apikey',
      'x-client-info',
      'x-supabase-api-version',
    ],
    credentials: true,
    maxAge: 600,
  });
}
