import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { jwtVerify } from 'jose';

// FHS-698: with GOTRUE_URL + GOTRUE_ADMIN_JWT_SECRET set, invites and email
// changes go to our private GoTrue server with a short-lived admin pass.

const SECRET = 'a'.repeat(64);

vi.mock('../../../../src/config.js', () => ({
  config: {
    GOTRUE_URL: 'http://gotrue.test:9999/',
    GOTRUE_ADMIN_JWT_SECRET: 'a'.repeat(64),
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'svc-key',
  },
}));

import { inviteUserByEmail, updateUserEmailById } from '../../../../src/security/supabase-admin.js';

describe('FHS-698: admin calls go to GoTrue when it is configured', () => {
  const realFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'u1', email: 'a@b.com' }), { status: 200 }),
      );
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  async function passFrom(call: number) {
    const headers = (fetchMock.mock.calls[call]![1] as { headers: Record<string, string> }).headers;
    expect(headers.apikey).toBeUndefined();
    const token = headers.Authorization!.replace(/^Bearer /, '');
    const { payload, protectedHeader } = await jwtVerify(token, new TextEncoder().encode(SECRET));
    return { payload, protectedHeader };
  }

  it('sends invites to GoTrue at /invite with a one-minute service_role pass', async () => {
    await inviteUserByEmail({ email: 'a@b.com', redirectTo: 'https://web.example/auth/callback' });
    expect(fetchMock.mock.calls[0]![0]).toBe(
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
    expect(fetchMock.mock.calls[0]![0]).toBe('http://gotrue.test:9999/admin/users/user%201');
    expect((fetchMock.mock.calls[0]![1] as { method: string }).method).toBe('PUT');
    expect((await passFrom(0)).payload.role).toBe('service_role');
  });

  it('makes a fresh pass for every call', async () => {
    await updateUserEmailById('u1', 'x@b.com');
    await new Promise((r) => setTimeout(r, 1100));
    await updateUserEmailById('u1', 'y@b.com');
    const first = (await passFrom(0)).payload.iat!;
    const second = (await passFrom(1)).payload.iat!;
    expect(second).toBeGreaterThan(first);
  });
});
