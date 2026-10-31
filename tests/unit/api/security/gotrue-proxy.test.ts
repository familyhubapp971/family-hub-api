import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { gotrueProxy, MAX_BODY_BYTES } from '../../../../src/security/gotrue-proxy.js';

// FHS-694: the API passes /auth/v1/* through to the private GoTrue server.

const UPSTREAM = 'http://gotrue.test:9999';

function proxyApp() {
  const app = new Hono();
  app.all('/auth/v1/*', gotrueProxy(UPSTREAM));
  return app;
}

describe('FHS-694: gotrueProxy', () => {
  const realFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version: 'v2.197.0', name: 'GoTrue' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('forwards the path after /auth/v1 and the query string to GoTrue', async () => {
    const res = await proxyApp().request('/auth/v1/health?x=1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 'v2.197.0', name: 'GoTrue' });
    expect(fetchMock.mock.calls[0]![0]).toBe(`${UPSTREAM}/health?x=1`);
  });

  it('passes the method and body through, without the host header', async () => {
    await proxyApp().request('/auth/v1/otp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: 'api.example',
        'x-forwarded-for': '203.0.113.7',
      },
      body: JSON.stringify({ email: 'a@b.com' }),
    });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"email":"a@b.com"}');
    const headers = init.headers as Headers;
    expect(headers.get('host')).toBeNull();
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.7');
  });

  it('hands redirects back to the browser instead of following them', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://accounts.google.com/o' } }),
    );
    const res = await proxyApp().request('/auth/v1/authorize?provider=google');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).redirect).toBe('manual');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://accounts.google.com/o');
  });

  it('refuses admin paths without calling GoTrue', async () => {
    for (const path of [
      '/auth/v1/admin/users',
      '/auth/v1/ADMIN',
      '/auth/v1/%61dmin/users',
      '/auth/v1//admin/users',
      '/auth/v1///admin',
      '/auth/v1/./admin/users',
    ]) {
      const res = await proxyApp().request(path);
      expect(res.status, path).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses dot-dot and encoded slashes without calling GoTrue', async () => {
    for (const path of ['/auth/v1/%2Fadmin/users', '/auth/v1/x%5c..%5cadmin']) {
      const res = await proxyApp().request(path);
      expect(res.status, path).toBe(400);
    }
    // The URL parser itself resolves %2e%2e as "..", so this one never even
    // matches /auth/v1/*. Either way it must not reach GoTrue.
    const res = await proxyApp().request('/auth/v1/%2e%2e/admin');
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the cleaned path, not repeated slashes', async () => {
    await proxyApp().request('/auth/v1//health');
    expect(fetchMock.mock.calls[0]![0]).toBe(`${UPSTREAM}/health`);
  });

  it('refuses bodies over the size limit without calling GoTrue', async () => {
    const res = await proxyApp().request('/auth/v1/otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(MAX_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends HEAD requests on without a body', async () => {
    await proxyApp().request('/auth/v1/health', { method: 'HEAD' });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('HEAD');
    expect(init.body).toBeUndefined();
  });

  it('answers 502 when GoTrue is too slow', async () => {
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const res = await proxyApp().request('/auth/v1/health');
    expect(res.status).toBe(502);
  });

  it('answers 502 with a plain message when GoTrue cannot be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const res = await proxyApp().request('/auth/v1/health');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'sign-in service unavailable' });
  });
});

describe('FHS-694: /auth/v1 in the full app', () => {
  const realFetch = global.fetch;
  const realUrl = process.env.GOTRUE_URL;

  afterEach(() => {
    global.fetch = realFetch;
    if (realUrl === undefined) delete process.env.GOTRUE_URL;
    else process.env.GOTRUE_URL = realUrl;
    vi.resetModules();
  });

  it('reaches GoTrue with no sign-in token when GOTRUE_URL is set', async () => {
    process.env.GOTRUE_URL = UPSTREAM;
    vi.resetModules();
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('{"name":"GoTrue"}', { status: 200 })) as never;
    const { buildApp } = await import('../../../../src/app.js');
    const res = await buildApp().request('/auth/v1/health');
    expect(res.status).toBe(200);
  });

  it("lets the web app's sign-in headers through the browser preflight", async () => {
    process.env.GOTRUE_URL = UPSTREAM;
    const realOrigins = process.env.CORS_ALLOWED_ORIGINS;
    process.env.CORS_ALLOWED_ORIGINS = 'https://web.example';
    vi.resetModules();
    try {
      const { buildApp } = await import('../../../../src/app.js');
      const res = await buildApp().request('/auth/v1/otp', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://web.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'apikey, x-client-info, x-supabase-api-version',
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('https://web.example');
      const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
      for (const h of ['apikey', 'x-client-info', 'x-supabase-api-version']) {
        expect(allowed).toContain(h);
      }
    } finally {
      if (realOrigins === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
      else process.env.CORS_ALLOWED_ORIGINS = realOrigins;
    }
  });

  it('does not exist when GOTRUE_URL is unset', async () => {
    delete process.env.GOTRUE_URL;
    vi.resetModules();
    const { buildApp } = await import('../../../../src/app.js');
    const res = await buildApp().request('/auth/v1/health');
    expect(res.status).not.toBe(200);
  });
});
