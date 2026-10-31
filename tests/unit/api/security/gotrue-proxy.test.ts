import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { gotrueProxy, MAX_BODY_BYTES } from '../../../../src/security/gotrue-proxy.js';
import { SignInLimits } from '../../../../src/security/signin-limits.js';

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
      '/auth/v1/admin./users',
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

  it('stops reading a body with no declared size once it passes the limit', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(16 * 1024);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const res = await proxyApp().request(
      new Request('http://localhost/auth/v1/otp', {
        method: 'POST',
        body: endless,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    );
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(10);
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

describe('FHS-695: limits and the visitor address on the pass-through', () => {
  const realFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  function limitedApp() {
    const app = new Hono();
    const limits = new SignInLimits({ maxFailedAttempts: 5, lockoutMs: 900_000, emailsPerHour: 5 });
    app.all('/auth/v1/*', gotrueProxy(UPSTREAM, { limits }));
    return app;
  }
  const post = (app: Hono, path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('blocks a 6th password try after 5 failures, in GoTrue reply format', async () => {
    fetchMock.mockImplementation(
      async () => new Response('{"error_code":"invalid_credentials"}', { status: 400 }),
    );
    const app = limitedApp();
    for (let i = 0; i < 5; i++) {
      const res = await post(app, '/auth/v1/token?grant_type=password', {
        email: 'A@b.com',
        password: 'x',
      });
      expect(res.status).toBe(400);
    }
    const res = await post(app, '/auth/v1/token?grant_type=password', {
      email: 'a@b.com',
      password: 'x',
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('900');
    expect(await res.json()).toEqual({
      code: 429,
      error_code: 'over_request_rate_limit',
      msg: 'Too many sign-in attempts. Please wait 15 minutes and try again.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('counts typed-code checks as tries, but not magic link clicks', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 403 }));
    const app = limitedApp();
    for (let i = 0; i < 5; i++)
      await post(app, '/auth/v1/verify', { email: 'a@b.com', token: '000000', type: 'email' });
    expect(
      (await post(app, '/auth/v1/verify', { email: 'a@b.com', token: '1', type: 'email' })).status,
    ).toBe(429);
    const click = await app.request('/auth/v1/verify?token=abc&type=magiclink');
    expect(click.status).toBe(403);
  });

  it('does not count refresh-token requests as tries', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 400 }));
    const app = limitedApp();
    for (let i = 0; i < 7; i++) {
      const res = await post(app, '/auth/v1/token?grant_type=refresh_token', {
        refresh_token: 'r',
      });
      expect(res.status).toBe(400);
    }
  });

  it('allows 5 sign-in emails to one address an hour, then blocks', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    const app = limitedApp();
    for (let i = 0; i < 5; i++)
      expect((await post(app, '/auth/v1/otp', { email: 'a@b.com' })).status).toBe(200);
    const res = await post(app, '/auth/v1/otp', { email: 'a@b.com' });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error_code: string }).error_code).toBe(
      'over_email_send_rate_limit',
    );
    expect((await post(app, '/auth/v1/otp', { email: 'c@d.com' })).status).toBe(200);
  });

  it('does not charge an email to the address when GoTrue fails to send it', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 503 }));
    const app = limitedApp();
    for (let i = 0; i < 6; i++) await post(app, '/auth/v1/otp', { email: 'a@b.com' });
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    for (let i = 0; i < 3; i++) await post(app, '/auth/v1/otp', { email: 'a@b.com' });
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    expect((await post(app, '/auth/v1/otp', { email: 'a@b.com' })).status).toBe(200);
  });

  it("does not charge GoTrue's own refusals, such as its one-a-minute rule", async () => {
    fetchMock.mockImplementation(
      async () => new Response('{"error_code":"over_email_send_rate_limit"}', { status: 429 }),
    );
    const app = limitedApp();
    for (let i = 0; i < 8; i++) await post(app, '/auth/v1/otp', { email: 'a@b.com' });
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    expect((await post(app, '/auth/v1/otp', { email: 'a@b.com' })).status).toBe(200);
  });

  it('does not count a password try that GoTrue could not check', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 500 }));
    const app = limitedApp();
    for (let i = 0; i < 6; i++) {
      const res = await post(app, '/auth/v1/token?grant_type=password', {
        email: 'a@b.com',
        password: 'x',
      });
      expect(res.status).toBe(500);
    }
  });

  it('sends GoTrue only the visitor address this API trusts', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
    await limitedApp().request('/auth/v1/health', {
      headers: {
        'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2',
        'x-real-ip': '198.51.100.1',
      },
    });
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Headers;
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(headers.get('x-real-ip')).toBe('203.0.113.7');
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
