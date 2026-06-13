import type { Context, MiddlewareHandler } from 'hono';
import { jwtVerify, decodeJwt, errors as joseErrors } from 'jose';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

// Kid JWT consumer middleware (FHS-257).
//
// POST /api/auth/kid-pin (FHS-236) mints a short-lived HS256 token for a
// child member: { scope: 'child', sub: memberId, tenantId, tenantSlug,
// iss: 'family-hub-kid-auth' }. This middleware verifies that token and
// exposes the kid principal on the request context so kid-scoped routes
// know who they're serving — WITHOUT going through the parent Supabase
// (ES256/JWKS) auth path.
//
// Per the FHS-236 verifier note, jwtVerify is pinned to
// { algorithms: ['HS256'], issuer: 'family-hub-kid-auth' } so a forged
// `alg: 'none'` token or an algorithm-confusion attack is rejected.

const log = createLogger('kid-auth');

/** Issuer stamped into kid tokens by auth-kid-pin.ts — verified here. */
export const KID_ISSUER = 'family-hub-kid-auth';

export interface KidAuth {
  memberId: string;
  tenantId: string;
  tenantSlug: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    /** Set by kidAuthMiddleware when a valid kid token is present. */
    kidAuth: KidAuth | undefined;
  }
}

export interface KidAuthMiddlewareOptions {
  /** Override the HS256 secret. Production reads config.KID_AUTH_SECRET. */
  secret?: string;
}

function extractBearer(c: Context): string | null {
  const header = c.req.header('authorization') ?? c.req.header('Authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !match[1]) return null;
  const token = match[1].trim();
  return token || null;
}

/**
 * True when a token's UNVERIFIED claims look like a kid token (right
 * issuer + child scope). Lets the middleware decide whether to strictly
 * verify (and 401 on failure) or pass through untouched so a parent
 * token bound for a different auth layer isn't wrongly rejected.
 */
function looksLikeKidToken(token: string): boolean {
  try {
    const claims = decodeJwt(token);
    return claims.iss === KID_ISSUER && (claims as { scope?: unknown }).scope === 'child';
  } catch {
    return false;
  }
}

function invalid(c: Context, reason: string): Response {
  log.warn({ reason, path: c.req.path }, 'kid-auth: rejecting kid token');
  return c.json({ error: 'kid auth invalid', errorCode: 'KID_AUTH_INVALID' }, 401);
}

/**
 * Verifies the kid HS256 token and, on success, sets
 * `c.set('kidAuth', { memberId, tenantId, tenantSlug })`.
 *
 * Lenient: a request with a parent token (or none) passes through with
 * kidAuth unset — pair with `requireKidAuth` on kid-only routes to turn
 * "no kid principal" into a 403. A token that clearly IS a kid token but
 * fails verification (tampered / expired / wrong secret / missing claim)
 * is rejected 401 with errorCode KID_AUTH_INVALID.
 */
export function kidAuthMiddleware(opts: KidAuthMiddlewareOptions = {}): MiddlewareHandler {
  const secret = new TextEncoder().encode(opts.secret ?? config.KID_AUTH_SECRET);
  return async (c, next) => {
    const token = extractBearer(c);
    // looksLikeKidToken reads UNVERIFIED claims only to route the token —
    // the strict jwtVerify below (pinned alg + issuer) is what actually
    // authenticates it, so a forged "kid-shaped" token still 401s.
    if (!token || !looksLikeKidToken(token)) {
      await next();
      return;
    }
    try {
      const { payload } = await jwtVerify(token, secret, {
        algorithms: ['HS256'],
        issuer: KID_ISSUER,
      });
      const memberId = typeof payload.sub === 'string' ? payload.sub : undefined;
      const tenantId = typeof payload['tenantId'] === 'string' ? payload['tenantId'] : undefined;
      const tenantSlug =
        typeof payload['tenantSlug'] === 'string' ? payload['tenantSlug'] : undefined;
      const scope = (payload as { scope?: unknown }).scope;
      if (scope !== 'child' || !memberId || !tenantId || !tenantSlug) {
        return invalid(c, 'kid-token-missing-claims');
      }
      c.set('kidAuth', { memberId, tenantId, tenantSlug });
    } catch (err) {
      return invalid(c, mapVerifyError(err));
    }
    await next();
  };
}

function mapVerifyError(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return 'kid-token-expired';
  if (err instanceof joseErrors.JWTClaimValidationFailed) return 'kid-token-claim-invalid';
  if (err instanceof joseErrors.JWSSignatureVerificationFailed)
    return 'kid-token-signature-invalid';
  if (err instanceof joseErrors.JOSEError) return `jose-${err.code}`;
  return 'kid-verification-error';
}

/**
 * Guard for kid-only routes: 403 KID_REQUIRED when no kid principal is on
 * the context. A parent token (or no token) reaches here with kidAuth
 * unset, so this is what turns a parent request to a kid handler into the
 * 403 required by FHS-257's acceptance criteria.
 */
export const requireKidAuth: MiddlewareHandler = async (c, next) => {
  if (!c.get('kidAuth')) {
    return c.json({ error: 'kid login required', errorCode: 'KID_REQUIRED' }, 403);
  }
  await next();
};

/**
 * Guard for parent-only routes: 403 KID_ON_PARENT_ROUTE when the caller
 * presents a kid-shaped token. The parent auth middleware would otherwise
 * 401 the kid token (failed ES256 verify); this guard makes the rejection
 * an explicit 403 so a kid hitting a parent endpoint is unambiguous.
 */
export const rejectKidTokens: MiddlewareHandler = async (c, next) => {
  // Kid routes legitimately carry a kid token — never reject them here.
  const path = c.req.path;
  if (path === '/api/kid' || path.startsWith('/api/kid/')) {
    await next();
    return;
  }
  const token = extractBearer(c);
  if (token && looksLikeKidToken(token)) {
    return c.json({ error: 'parent login required', errorCode: 'KID_ON_PARENT_ROUTE' }, 403);
  }
  await next();
};

/**
 * Helper for kid route handlers behind `requireKidAuth`. Throws when no
 * kid principal is present — unreachable in production, but makes a
 * missing-guard mistake loud in development.
 */
export function getKidAuth(c: Context): KidAuth {
  const kid = c.get('kidAuth');
  if (!kid) {
    throw new Error(
      'getKidAuth called on a request that did not pass kidAuthMiddleware + requireKidAuth — ' +
        'mount both before this handler.',
    );
  }
  return kid;
}
