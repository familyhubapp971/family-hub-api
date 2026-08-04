import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// FHS-352: invites never sent because the wrapper POSTed to /auth/v1/admin/invite
// (404). The correct GoTrue endpoint is /auth/v1/invite, with redirect_to as a
// query param. These tests lock the endpoint + the already-registered classifier.

vi.mock('../../../../apps/api/src/config.js', () => ({
  config: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc-key' },
}));

import {
  inviteUserByEmail,
  isEmailAlreadyRegisteredError,
  SupabaseAdminError,
} from '../../../../apps/api/src/lib/supabase-admin.js';

describe('FHS-352: inviteUserByEmail endpoint', () => {
  const realFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('POSTs to /auth/v1/invite (not /admin/invite) with redirect_to as a query param', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 'u1', email: 'a@b.com' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const redirectTo = 'https://app.example/auth/callback?invite=abc';
    await inviteUserByEmail({ email: 'a@b.com', redirectTo, data: { x: 1 } });

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/auth/v1/invite?');
    expect(url).not.toContain('/admin/invite');
    expect(url).toContain(`redirect_to=${encodeURIComponent(redirectTo)}`);

    const init = fetchMock.mock.calls[0]![1] as { body: string };
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body.email).toBe('a@b.com');
    expect(body.data).toEqual({ x: 1 });
    // redirect_to belongs in the query, not the body.
    expect(body.redirect_to).toBeUndefined();
  });

  it('throws SupabaseAdminError on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));
    await expect(inviteUserByEmail({ email: 'a@b.com', redirectTo: 'x' })).rejects.toBeInstanceOf(
      SupabaseAdminError,
    );
  });
});

describe('FHS-352: isEmailAlreadyRegisteredError', () => {
  it('matches a 422 and the body markers, not other errors', () => {
    expect(isEmailAlreadyRegisteredError(new SupabaseAdminError('x', 422, ''))).toBe(true);
    expect(
      isEmailAlreadyRegisteredError(new SupabaseAdminError('x', 500, '{"code":"email_exists"}')),
    ).toBe(true);
    expect(isEmailAlreadyRegisteredError(new SupabaseAdminError('x', 500, 'something else'))).toBe(
      false,
    );
    expect(isEmailAlreadyRegisteredError(new Error('plain'))).toBe(false);
  });
});
