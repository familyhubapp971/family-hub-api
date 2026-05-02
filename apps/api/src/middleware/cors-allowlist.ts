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
      if (!origin) return undefined; // same-origin / curl — let it through

      // Explicit allowlist always wins.
      if (explicit.length > 0) {
        return explicit.includes(origin) ? origin : null;
      }

      // Localhost dev: any port on 127.0.0.1 / localhost, http only.
      if (config.BASE_DOMAIN === 'localhost') {
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
        return null;
      }

      // Production: BASE_DOMAIN apex + any *.subdomain. https only —
      // a misconfigured proxy or attacker-controlled origin must not
      // get a credentialed allow over plaintext.
      const escaped = config.BASE_DOMAIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^https://([a-z0-9-]+\\.)*${escaped}$`);
      return re.test(origin) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 600,
  });
}
