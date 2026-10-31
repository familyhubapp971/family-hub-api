import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { jwtVerify } from 'jose';

// FHS-698: with GOTRUE_URL + GOTRUE_ADMIN_JWT_SECRET set, invites and email
// changes go to our private GoTrue server with a short-lived admin pass.
// Anything less falls back to Supabase, exactly as before.

const SECRET = 'a'.repeat(64);
const settings: Record<string, string | undefined> = {};

vi.mock('../../../../src/config.js', () => ({
  config: new Proxy({}, { get: (_t, key: string) => settings[key] }),
}));

const { inviteUserByEmail, updateUserEmailById } = await import(
  '../../../../src/security/supabase-admin.js'
);

describe('FHS-698: where admin calls go', () => {
  const realFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    Object.assign(settings, {
      GOTRUE_URL: 'http://gotrue.test:9999/',
      GOTRUE_ADMIN_JWT_SECRET: SECRET,
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'svc-key',
    });
    fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'u1', email: 'a@b.com' }), { status: 200 }),
      );
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
    vi.useRealTimers();
    for (const k of Object.keys(settings)) delete settings[k];
  });

  const call = (n: number) =>
    fetchMock.mock.calls[n]! as [string, { method: string; headers: Record<string, string> }];

  async function passFrom(n: number) {
    const { headers } = call(n)[1];
    expect(headers.apikey).toBeUndefined();
    const token = headers.Authorization!.replace(/^Bearer /, '');
    return jwtVerify(token, new TextEncoder().encode(SECRET));
  }

  it('sends invites to GoTrue at /invite with a one-minute service_role pass', async () => {
    await inviteUserByEmail({ email: 'a@b.com', redirectTo: 'https://web.example/auth/callback' });
    expect(call(0)[0]).toBe(
      'http://gotrue.test:9999/invite?redirect_to=' +
        encodeURIComponent('https://web.example/auth/callback'),
    );
    const { payload, protectedHeader } = await passFrom(0);
    expect(protectedHeader.alg).toBe('HS256');
    expect(payload.role).toBe('service_role');
    expect(payload.exp! - payload.iat!).toBe(60);
  });

  it('sends email changes to GoTrue at /admin/users/:id', async () => {
    await updateUserEmailById('user 1', 'new@b.com');
    expect(call(0)[0]).toBe('http://gotrue.test:9999/admin/users/user%201');
    expect(call(0)[1].method).toBe('PUT');
    expect((await passFrom(0)).payload.role).toBe('service_role');
  });

  it('makes a fresh pass for every call', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
    await updateUserEmailById('u1', 'x@b.com');
    vi.setSystemTime(new Date('2026-10-31T12:00:05Z'));
    await updateUserEmailById('u1', 'y@b.com');
    const decode = (n: number) =>
      JSON.parse(
        Buffer.from(call(n)[1].headers.Authorization!.split('.')[1]!, 'base64url').toString(),
      ) as { iat: number };
    expect(decode(1).iat - decode(0).iat).toBe(5);
  });

  it('stays on Supabase when GOTRUE_URL is set but the secret is not', async () => {
    delete settings.GOTRUE_ADMIN_JWT_SECRET;
    await updateUserEmailById('u1', 'x@b.com');
    expect(call(0)[0]).toBe('https://test.supabase.co/auth/v1/admin/users/u1');
    expect(call(0)[1].headers.apikey).toBe('svc-key');
  });

  it('stays on Supabase when the secret is set but GOTRUE_URL is not', async () => {
    delete settings.GOTRUE_URL;
    await inviteUserByEmail({ email: 'a@b.com', redirectTo: 'https://web.example/cb' });
    expect(call(0)[0]).toMatch(/^https:\/\/test\.supabase\.co\/auth\/v1\/invite\?/);
  });
});
