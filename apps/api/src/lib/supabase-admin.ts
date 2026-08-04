import { config } from '../config.js';

// Thin wrapper around Supabase's auth admin REST API. We hit /auth/v1
// directly via fetch rather than pulling in `@supabase/supabase-js`:
// the api only needs a handful of admin endpoints, and avoiding the
// SDK keeps our dep tree small and the failure surface explicit.
//
// The service-role key is required: it grants full admin access to
// Supabase Auth. NEVER expose it to clients.

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

function requireConfig(): { url: string; key: string } {
  if (!config.SUPABASE_URL) {
    throw new Error('SUPABASE_URL is required for the Supabase admin client');
  }
  if (!config.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for the Supabase admin client');
  }
  return { url: config.SUPABASE_URL, key: config.SUPABASE_SERVICE_ROLE_KEY };
}

/**
 * Send a magic-link invitation via Supabase admin. Returns the created
 * (or pre-existing: Supabase upserts) auth user. The invitee receives
 * a Supabase-templated email with a one-time link to `redirectTo`.
 *
 * Maps to FHS-91's POST /api/invitations handler.
 */
export async function inviteUserByEmail(
  opts: SupabaseInviteUserOptions,
): Promise<SupabaseInvitedUser> {
  const { url, key } = requireConfig();
  // GoTrue's admin invite endpoint is `/auth/v1/invite`: NOT `/auth/v1/admin/invite`,
  // which 404s (that 404 is why invites never sent; FHS-352). `redirect_to` is a
  // query parameter here, not a body field.
  const inviteUrl = `${url}/auth/v1/invite?redirect_to=${encodeURIComponent(opts.redirectTo)}`;
  const res = await fetch(inviteUrl, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: opts.email,
      data: opts.data ?? {},
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new SupabaseAdminError(`Supabase admin invite failed: ${res.status}`, res.status, text);
  }

  const parsed = JSON.parse(text) as { id?: string; email?: string };
  if (!parsed.id) {
    throw new SupabaseAdminError('Supabase admin invite returned no user id', res.status, text);
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
 * Maps to `PUT {SUPABASE_URL}/auth/v1/admin/users/{userId}`.
 */
export async function updateUserEmailById(userId: string, email: string): Promise<void> {
  const { url, key } = requireConfig();
  const res = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, email_confirm: true }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new SupabaseAdminError(
      `Supabase admin update-email failed: ${res.status}`,
      res.status,
      text,
    );
  }
}
