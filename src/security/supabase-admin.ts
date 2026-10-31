import { SignJWT } from 'jose';
import { config } from '../config.js';

// Thin wrapper around the sign-in server's admin REST API: our own GoTrue when
// GOTRUE_URL + GOTRUE_ADMIN_JWT_SECRET are set (FHS-698), otherwise Supabase
// (which runs GoTrue too, under /auth/v1). Plain fetch rather than
// `@supabase/supabase-js`: the api only needs a handful of admin endpoints.
//
// Admin access can act as any user. NEVER expose the service-role key, the
// GoTrue secret or a pass signed with it to clients.

export interface SupabaseInviteUserOptions {
  /** Email address to invite. */
  email: string;
  /** Where Supabase should redirect after the invitee clicks the link. */
  redirectTo: string;
  /**
   * Custom claims merged into the user's `user_metadata`: the accept
   * handler (FHS-92) reads this to know which invite the redemption
   * applies to.
   */
  data?: Record<string, unknown>;
}

export interface SupabaseInvitedUser {
  id: string;
  email?: string;
}

export class SupabaseAdminError extends Error {
  // Truncated to 200 chars so a logger that dumps the whole error
  // (Sentry, structured `log.error({ err })`) can't accidentally
  // emit a multi-kilobyte response body. The full body is still
  // available for the immediate caller via the constructor scope:
  // we just don't expose it as a serialised property.
  readonly responseSnippet: string;

  constructor(
    message: string,
    readonly status: number,
    body: string,
  ) {
    super(message);
    this.responseSnippet = body.slice(0, 200);
  }

  // Belt + braces against accidental serialisation: anything that
  // JSON-stringifies the error gets only the safe fields.
  toJSON() {
    return {
      name: 'SupabaseAdminError',
      message: this.message,
      status: this.status,
      responseSnippet: this.responseSnippet,
    };
  }
}

/**
 * True when a Supabase admin-invite failure means the email already has an auth
 * account. The invite endpoint returns 422 for an existing user; we also match
 * the body markers in case the status code shifts across Supabase versions.
 * (FHS-352: used to turn a confusing 502 into a clear "already registered".)
 */
export function isEmailAlreadyRegisteredError(err: unknown): boolean {
  if (!(err instanceof SupabaseAdminError)) return false;
  if (err.status === 422) return true;
  const snippet = err.responseSnippet.toLowerCase();
  return (
    snippet.includes('already been registered') ||
    snippet.includes('email_exists') ||
    snippet.includes('already registered')
  );
}

interface AdminTarget {
  /** Base of the admin endpoints: GoTrue's root, or Supabase's /auth/v1. */
  base: string;
  headers: Record<string, string>;
}

/**
 * FHS-698: where admin calls go. With GOTRUE_URL and GOTRUE_ADMIN_JWT_SECRET
 * set, they go straight to our private GoTrue server with a one-minute
 * service_role pass signed by its own secret, so no long-lived admin key
 * exists. Otherwise they go to Supabase with its service-role key, as before.
 */
async function adminTarget(): Promise<AdminTarget> {
  if (config.GOTRUE_URL && config.GOTRUE_ADMIN_JWT_SECRET) {
    const token = await new SignJWT({ role: 'service_role', iss: 'supabase' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(new TextEncoder().encode(config.GOTRUE_ADMIN_JWT_SECRET));
    return {
      base: config.GOTRUE_URL.replace(/\/+$/, ''),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    };
  }
  if (!config.SUPABASE_URL) {
    throw new Error('SUPABASE_URL is required for the Supabase admin client');
  }
  if (!config.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for the Supabase admin client');
  }
  const key = config.SUPABASE_SERVICE_ROLE_KEY;
  return {
    base: `${config.SUPABASE_URL}/auth/v1`,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  };
}

/**
 * Send a magic-link invitation via the sign-in server's admin API. Returns the created
 * (or pre-existing: Supabase upserts) auth user. The invitee receives
 * a Supabase-templated email with a one-time link to `redirectTo`.
 *
 * Maps to FHS-91's POST /api/invitations handler.
 */
export async function inviteUserByEmail(
  opts: SupabaseInviteUserOptions,
): Promise<SupabaseInvitedUser> {
  const { base, headers } = await adminTarget();
  // GoTrue's admin invite endpoint is `/invite` (`/auth/v1/invite` on Supabase):
  // NOT `/admin/invite`, which 404s (that 404 is why invites never sent;
  // FHS-352). `redirect_to` is a query parameter here, not a body field.
  const inviteUrl = `${base}/invite?redirect_to=${encodeURIComponent(opts.redirectTo)}`;
  const res = await fetch(inviteUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email: opts.email,
      data: opts.data ?? {},
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new SupabaseAdminError(`auth admin invite failed: ${res.status}`, res.status, text);
  }

  const parsed = JSON.parse(text) as { id?: string; email?: string };
  if (!parsed.id) {
    throw new SupabaseAdminError('auth admin invite returned no user id', res.status, text);
  }
  return { id: parsed.id, ...(parsed.email ? { email: parsed.email } : {}) };
}

/**
 * Change a Supabase auth user's sign-in email via the admin API (FHS-510).
 * `email_confirm: true` marks the new address confirmed immediately: we've
 * already verified ownership ourselves (the user clicked a one-time link
 * emailed to that exact address), so there's no need for Supabase to send a
 * SECOND confirmation email on top of ours.
 *
 * Maps to `PUT {GOTRUE_URL}/admin/users/{userId}`, or
 * `PUT {SUPABASE_URL}/auth/v1/admin/users/{userId}` while on Supabase.
 */
export async function updateUserEmailById(userId: string, email: string): Promise<void> {
  const { base, headers } = await adminTarget();
  const res = await fetch(`${base}/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ email, email_confirm: true }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new SupabaseAdminError(`auth admin update-email failed: ${res.status}`, res.status, text);
  }
}
