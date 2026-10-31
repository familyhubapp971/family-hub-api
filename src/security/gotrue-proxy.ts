import type { Context } from 'hono';
import { createLogger } from '../services/logger.js';

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

export function gotrueProxy(upstream: string) {
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

    let res: Response;
    try {
      res = await fetch(`${base}${rest}${url.search}`, init);
    } catch (err) {
      log.warn(
        { path: rest, err: err instanceof Error ? err.message : String(err) },
        'sign-in service unreachable',
      );
      return c.json({ error: 'sign-in service unavailable' }, 502);
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
