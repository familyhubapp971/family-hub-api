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

export function gotrueProxy(upstream: string) {
  const base = upstream.replace(/\/+$/, '');

  return async (c: Context): Promise<Response> => {
    const url = new URL(c.req.url);
    const rest = url.pathname.slice(GOTRUE_PREFIX.length) || '/';

    let decoded: string;
    try {
      decoded = decodeURIComponent(rest).toLowerCase();
    } catch {
      return c.json({ error: 'bad request' }, 400);
    }
    if (decoded === '/admin' || decoded.startsWith('/admin/')) {
      return c.json({ error: 'not found' }, 404);
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
      init.body = await c.req.raw.arrayBuffer();
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
