import type { Context, MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { config } from '../config.js';
import type { User } from '../db/schema.js';
import type { UserMirrorClaims } from '../lib/user-mirror.js';
import { createLogger } from '../logger.js';

/** Function shape for mirror sync — `getOrCreateUser` bound to a Database, or a test stub. */
export type UserMirrorSync = (claims: UserMirrorClaims) => Promise<User>;

// JWT verification middleware (FHS-191).
//
// Modern Supabase signs session JWTs with ES256 and exposes the public
// keys at <SUPABASE_URL>/auth/v1/.well-known/jwks.json. The middleware
// fetches that JWKS once, caches it, and refreshes on key-id miss. We
// never trust the legacy HS256 / shared-secret path — see ADR 0008.
//
// Order in app.ts: cors → request-context → rate-limit → AUTH → tenant
// resolution. Tenant context (FHS-192) keys off the authenticated user,
// so auth must run first.

const log = createLogger('auth');

const PUBLIC_PATH_PREFIXES = [
  '/health',
  '/hello',
  // FHS-27 — slug availability is a yes/no fact about the public DNS
  // namespace; gating it behind auth would force the signup form to
  // sign the user in before they've even picked a family name.
  '/api/public/slug-available',
] as const;

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthenticatedUser | undefined;
    /** Mirror row from public.users (FHS-192/194). Set after JWT verify on protected routes. */
    userRow: User | undefined;
  }
}

export interface AuthenticatedUser {
  id: string;
  email?: string;
  /** Raw verified payload — handlers may need claims we don't surface explicitly. */
  claims: JWTPayload;
}

export interface AuthMiddlewareOptions {
  /**
   * Override the JWKS resolver. Production leaves this undefined and the
   * middleware builds a remote JWKS bound to SUPABASE_URL. Tests inject
   * a local JWKS so they don't hit the network and can mint matching
   * tokens with a known private key.
   */
  jwks?: JWTVerifyGetKey;
  /**
   * Override the issuer claim. Defaults to `${SUPABASE_URL}/auth/v1`
   * which matches what the Supabase auth server stamps into tokens.
   */
  issuer?: string;
  /**
   * Extra path prefixes (e.g. webhook callbacks) that bypass auth in
   * addition to the built-in /health and /hello.
   */
  publicPathPrefixes?: readonly string[];
  /**
   * Override the users-mirror sync function. Production binds
   * `getOrCreateUser` to the lazy-pool `getDb()`. Tests pass a stub
   * that returns a fixture row without touching Postgres.
   */
  userMirrorSync?: UserMirrorSync;
}

let cachedDefaultJwks: JWTVerifyGetKey | undefined;

/**
 * Build (or reuse) the JWKS resolver for SUPABASE_URL. `createRemoteJWKSet`
 * returns a function that handles its own cache + cooldown internally:
 * keys are fetched on first call, cached for `cacheMaxAge` ms, and refetched
 * when a token's `kid` doesn't match any cached key (subject to `cooldownDuration`
 * to avoid hammering the JWKS endpoint on a bad token storm).
 */
function getDefaultJwks(): JWTVerifyGetKey | undefined {
  if (cachedDefaultJwks) return cachedDefaultJwks;
  if (!config.SUPABASE_URL) return undefined;

  const url = new URL('/auth/v1/.well-known/jwks.json', config.SUPABASE_URL);
  cachedDefaultJwks = createRemoteJWKSet(url, {
    cacheMaxAge: config.JWKS_CACHE_TTL_MS,
    // 30s cooldown between refreshes triggered by an unknown kid — bounds
    // the blast radius of a flood of forged tokens with random kids.
    cooldownDuration: 30_000,
  });
  return cachedDefaultJwks;
}

/** Test-only — clears the module-level cache so a fresh JWKS is built next call. */
export function _resetJwksCacheForTests(): void {
  cachedDefaultJwks = undefined;
}

function isPublicPath(path: string, extras: readonly string[]): boolean {
  for (const prefix of PUBLIC_PATH_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  for (const prefix of extras) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function unauthorized(c: Context, reason: string, requestId?: string) {
  // Don't leak verification details to the client. The reason ends up in
  // structured logs; the response stays a flat 401 with the generic
  // error envelope used by the rest of the api.
  log.warn({ reason, request_id: requestId, path: c.req.path }, 'auth: rejecting request');
  return c.json({ error: 'unauthorized' }, 401);
}

/**
 * Hono middleware that verifies the `Authorization: Bearer <token>` header
 * against the Supabase JWKS, attaches the user to context on success, and
 * returns 401 otherwise. Public path prefixes (`/health`, `/hello`) are
 * short-circuited before any header inspection.
 */
export function authMiddleware(opts: AuthMiddlewareOptions = {}): MiddlewareHandler {
  const issuer =
    opts.issuer ?? (config.SUPABASE_URL ? `${config.SUPABASE_URL}/auth/v1` : undefined);
  const publicExtras = opts.publicPathPrefixes ?? [];

  return async (c, next) => {
    const requestId = c.get('requestId');

    if (isPublicPath(c.req.path, publicExtras)) {
      await next();
      return;
    }

    // Resolve the JWKS source per-request — that lets tests inject one
    // via the options without restarting the app.
    const jwks = opts.jwks ?? getDefaultJwks();
    if (!jwks || !issuer) {
      // Fail-closed: if the api was started without SUPABASE_URL, every
      // protected request gets a 401. Production validates SUPABASE_URL
      // at boot (config.ts), so this branch only fires in misconfigured
      // dev/test setups.
      return unauthorized(c, 'jwks-unavailable', requestId);
    }

    const header = c.req.header('authorization') ?? c.req.header('Authorization');
    if (!header) return unauthorized(c, 'missing-authorization-header', requestId);

    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match || !match[1]) return unauthorized(c, 'malformed-authorization-header', requestId);
    const token = match[1].trim();
    if (!token) return unauthorized(c, 'empty-bearer-token', requestId);

    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, jwks, {
        algorithms: ['ES256'],
        issuer,
      });
      payload = verified.payload;
    } catch (err) {
      const reason = mapVerifyError(err);
      return unauthorized(c, reason, requestId);
    }

    const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
    if (!sub) return unauthorized(c, 'token-missing-sub-claim', requestId);

    const email = typeof payload['email'] === 'string' ? (payload['email'] as string) : undefined;
    const user: AuthenticatedUser =
      email !== undefined ? { id: sub, email, claims: payload } : { id: sub, claims: payload };
    c.set('user', user);

    // Mirror sync (FHS-192/194). One INSERT…ON CONFLICT DO UPDATE
    // RETURNING per protected request — idempotent, single round-trip.
    // Reject if email is missing because the mirror table requires it
    // (Supabase always stamps email on the JWT for password + OAuth flows).
    // Mirror sync (FHS-192/194). Opt-in: if no sync function is wired,
    // skip — useful for unit tests of the auth middleware in isolation
    // and for any future routes that don't need the mirror row.
    // Production wiring (app.ts) provides a sync function bound to the
    // real DB pool.
    if (opts.userMirrorSync) {
      if (!email) return unauthorized(c, 'token-missing-email-claim', requestId);
      try {
        const row = await opts.userMirrorSync({ id: sub, email });
        c.set('userRow', row);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err), request_id: requestId, sub },
          'auth: users-mirror upsert failed',
        );
        return c.json({ error: 'internal server error' }, 500);
      }
    }

    await next();
  };
}

function mapVerifyError(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return 'token-expired';
  if (err instanceof joseErrors.JWTClaimValidationFailed) return 'token-claim-invalid';
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return 'token-signature-invalid';
  if (err instanceof joseErrors.JWKSNoMatchingKey) return 'jwks-no-matching-key';
  if (err instanceof joseErrors.JOSEError) return `jose-${err.code}`;
  // Network errors from the JWKS fetch — fail-closed but capture for ops.
  if (err instanceof Error) {
    log.error({ err: err.message }, 'auth: unexpected verification error');
    return 'verification-error';
  }
  return 'unknown-error';
}

/**
 * Helper for route handlers behind the auth middleware. Throws when no
 * user is on the context — that should be unreachable in production
 * because the middleware rejects pre-handler, but the throw makes the
 * "I forgot to mount auth" mistake loud during development.
 */
export function getAuthenticatedUser(c: Context): AuthenticatedUser {
  const user = c.get('user');
  if (!user) {
    throw new Error(
      'getAuthenticatedUser called on a request that did not pass authMiddleware — ' +
        'mount the middleware before this handler or move the route under PUBLIC_PATH_PREFIXES.',
    );
  }
  return user;
}
