import type { Context } from 'hono';
import { createLogger } from '../services/logger.js';
import { clientIpOf } from './rate-limit.js';
import type { SignInLimits } from './signin-limits.js';

const log = createLogger('gotrue-proxy');

// FHS-694: GoTrue (our own sign-in server) runs privately on Railway with no
// public address. Browsers reach it only through this pass-through, mounted at
// /auth/v1/* so the web app's Supabase client works unchanged when pointed at
// this API. Admin paths are refused here: the server calls them directly over
// the private network (FHS-698), never on behalf of a browser.

export const GOTRUE_PREFIX = '/auth/v1';

const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

const UPSTREAM_TIMEOUT_MS = 15_000;

// Sign-in requests are tiny (an email, a code, a token). Anything bigger is
// refused before it is read, since this path is open to anyone.
export const MAX_BODY_BYTES = 64 * 1024;

// Reads the body but stops as soon as it passes `max`, so a request with no
// (or a false) content-length cannot make us hold a large body in memory.
async function readLimited(req: Request, max: number): Promise<ArrayBuffer | null> {
  if (!req.body) return new ArrayBuffer(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

// FHS-695: GoTrue endpoints that send a sign-in email, and those that check a
// password or a typed code (the guessable ones). Keyed by email address.
const EMAIL_SENDING = new Set(['otp', 'signup', 'recover', 'magiclink', 'resend']);

function emailFrom(body: ArrayBuffer | undefined): string | undefined {
  if (!body || body.byteLength === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    const email = (parsed as { email?: unknown } | null)?.email;
    return typeof email === 'string' && email.includes('@')
      ? email.trim().toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

// Same shape GoTrue uses for its own limits, so the web app's sign-in client
// and error wording treat ours exactly like GoTrue's.
function limited(errorCode: string, msg: string, retryAfterMs: number): Response {
  return new Response(JSON.stringify({ code: 429, error_code: errorCode, msg }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'retry-after': String(Math.ceil(retryAfterMs / 1000)),
    },
  });
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  return m === 1 ? '1 minute' : `${m} minutes`;
}

export interface GotrueProxyOptions {
  limits?: SignInLimits;
}

export function gotrueProxy(upstream: string, opts: GotrueProxyOptions = {}) {
  const base = upstream.replace(/\/+$/, '');

  return async (c: Context): Promise<Response> => {
    const url = new URL(c.req.url);

    // Rebuild the path from its segments so `//admin`, `./admin` and similar
    // spellings cannot slip past the admin check, then forward the clean form.
    const rawSegments = url.pathname
      .slice(GOTRUE_PREFIX.length)
      .split('/')
      .filter((s) => s !== '' && s !== '.');
    let segments: string[];
    try {
      segments = rawSegments.map((s) => decodeURIComponent(s).toLowerCase());
    } catch {
      return c.json({ error: 'bad request' }, 400);
    }
    if (segments.some((s) => s === '..' || s === '.' || s.includes('/') || s.includes('\\'))) {
      return c.json({ error: 'bad request' }, 400);
    }
    if (segments[0]?.replace(/\.+$/, '') === 'admin') {
      return c.json({ error: 'not found' }, 404);
    }
    const rest = `/${rawSegments.join('/')}`;

    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > MAX_BODY_BYTES) {
      return c.json({ error: 'request too large' }, 413);
    }

    const headers = new Headers(c.req.raw.headers);
    for (const h of [...HOP_BY_HOP, 'host', 'content-length', 'accept-encoding']) {
      headers.delete(h);
    }
    // FHS-695: GoTrue sees the caller's address as this API trusts it, not a
    // chain the browser could pad, so its own per-address limits line up.
    const ip = clientIpOf(c);
    headers.delete('x-forwarded-for');
    headers.delete('x-real-ip');
    if (ip) {
      headers.set('x-forwarded-for', ip);
      headers.set('x-real-ip', ip);
    }

    const method = c.req.method;
    const init: RequestInit = {
      method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    };
    if (method !== 'GET' && method !== 'HEAD') {
      const body = await readLimited(c.req.raw, MAX_BODY_BYTES);
      if (body === null) {
        return c.json({ error: 'request too large' }, 413);
      }
      init.body = body;
    }

    const endpoint = segments[0] ?? '';
    const isPost = method === 'POST';
    const checksSecret =
      isPost &&
      ((endpoint === 'token' && url.searchParams.get('grant_type') === 'password') ||
        endpoint === 'verify');
    const sendsEmail = isPost && EMAIL_SENDING.has(endpoint);
    const email =
      opts.limits && (checksSecret || sendsEmail)
        ? emailFrom(init.body as ArrayBuffer | undefined)
        : undefined;

    let emailSentAt: number | undefined;
    if (opts.limits && email) {
      if (checksSecret) {
        const verdict = opts.limits.checkTry(email);
        if (verdict.blocked) {
          return limited(
            'over_request_rate_limit',
            `Too many sign-in attempts. Please wait ${minutes(verdict.retryAfterMs)} and try again.`,
            verdict.retryAfterMs,
          );
        }
      } else {
        const verdict = opts.limits.takeEmail(email);
        if (!verdict.blocked) emailSentAt = verdict.sentAt;
        if (verdict.blocked) {
          return limited(
            'over_email_send_rate_limit',
            `Too many sign-in emails to this address. Please wait ${minutes(verdict.retryAfterMs)} and try again.`,
            verdict.retryAfterMs,
          );
        }
      }
    }

    let res: Response;
    try {
      res = await fetch(`${base}${rest}${url.search}`, init);
    } catch (err) {
      if (opts.limits && email && emailSentAt !== undefined) {
        opts.limits.refundEmail(email, emailSentAt);
      }
      log.warn(
        { path: rest, err: err instanceof Error ? err.message : String(err) },
        'sign-in service unreachable',
      );
      return c.json({ error: 'sign-in service unavailable' }, 502);
    }

    if (opts.limits && email && checksSecret && res.status < 500) {
      opts.limits.recordTry(email, res.status >= 200 && res.status < 300);
    }
    // Only an email GoTrue actually sent counts. Its own refusals (such as its
    // one-a-minute rule) and failures send nothing, so they are given back.
    if (
      opts.limits &&
      email &&
      emailSentAt !== undefined &&
      (res.status < 200 || res.status >= 300)
    ) {
      opts.limits.refundEmail(email, emailSentAt);
    }

    // fetch has already decoded any compressed body, so the original
    // encoding and length headers no longer describe what we send on.
    const out = new Headers(res.headers);
    for (const h of [...HOP_BY_HOP, 'content-encoding', 'content-length']) {
      out.delete(h);
    }
    return new Response(res.body, { status: res.status, headers: out });
  };
}
