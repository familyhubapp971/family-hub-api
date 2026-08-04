import { config } from '../config.js';
import { createLogger } from '../logger.js';

// FHS-510: minimal Resend (transactional email) sender. Only the
// admin-initiated sign-in email change (FHS-510) uses this today; Supabase
// itself sends every OTHER transactional email (magic link, invite) via its
// own SMTP-over-Resend config (see project_email_fhapp_domain memory): this
// is a DIRECT Resend API call for the one flow Supabase's auth templates
// can't cover (a link that's consumed by a plain API endpoint, not Supabase
// auth itself).

const log = createLogger('email');

/**
 * Minimal HTML-entity escape for values interpolated into an email
 * template (e.g. a member's display name, an email address, a URL). This is
 * NOT a general sanitizer: it only escapes the five characters that matter
 * for breaking out of HTML text or a quoted attribute, which is exactly what
 * a template string needs. Every value spliced into an email HTML template
 * MUST go through this first: a display name is user-controlled (an admin
 * or the member themselves can set it), so skipping this is an HTML/link
 * injection hole in a branded, trusted-looking auth email.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

export interface SendEmailResult {
  ok: boolean;
  /** Present only when ok is false: never thrown, so a failed send degrades
   * gracefully (the caller decides whether that's fatal for the request). */
  error?: string;
}

/**
 * POST a single transactional email via the Resend API. Never throws: a
 * missing RESEND_API_KEY or a non-2xx Resend response is logged and returned
 * as `{ ok: false, error }` so a boot-time or request-time misconfiguration
 * can't crash the process; the caller (e.g. the email-change request
 * handler) decides how to surface that to the client.
 */
export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  if (!config.RESEND_API_KEY) {
    log.error({ to: opts.to }, 'sendEmail: RESEND_API_KEY not configured: email not sent');
    return { ok: false, error: 'email sender not configured' };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${config.RESEND_FROM_NAME} <${config.RESEND_FROM_EMAIL}>`,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.error(
        { to: opts.to, status: res.status, body: text.slice(0, 200) },
        'sendEmail: Resend returned a non-2xx response',
      );
      return { ok: false, error: `email send failed (${res.status})` };
    }
    return { ok: true };
  } catch (err) {
    log.error(
      { to: opts.to, err: err instanceof Error ? err.message : String(err) },
      'sendEmail: request to Resend failed',
    );
    return { ok: false, error: 'email send failed' };
  }
}
