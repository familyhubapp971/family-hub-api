import { describe, it, expect, vi } from 'vitest';
import { readSourceAccounts } from '../../../../src/security/account-copy-source.js';

// FHS-705: Supabase's account list leaves out each account's sign-in links;
// only the one-account view has them. The production practice run saw 35
// accounts and 0 links because the copy tool read the list alone.

const BASE = 'https://ref.supabase.co';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function link(userId: string, provider: string) {
  return { id: `${provider}-${userId}`, user_id: userId, provider };
}

describe('FHS-705: readSourceAccounts', () => {
  it('reads each account on its own, because the list leaves the links out', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/users?')) return json({ users: [{ id: A }, { id: B }] });
      const id = url.split('/').pop()!;
      return json({
        id,
        identities: id === A ? [link(A, 'email'), link(A, 'google')] : [link(B, 'email')],
      });
    });
    const users = await readSourceAccounts(BASE, 'svc', fetchFn as unknown as typeof fetch);
    expect(users.map((u) => (u.identities ?? []).map((i) => i.provider))).toEqual([
      ['email', 'google'],
      ['email'],
    ]);
    expect(fetchFn.mock.calls.map((c) => c[0])).toEqual([
      `${BASE}/auth/v1/admin/users?page=1&per_page=500`,
      `${BASE}/auth/v1/admin/users/${A}`,
      `${BASE}/auth/v1/admin/users/${B}`,
    ]);
    const init = fetchFn.mock.calls[0]![1] as unknown as RequestInit;
    expect(init.headers).toEqual({ apikey: 'svc', Authorization: 'Bearer svc' });
  });

  it('reads every page of the list', async () => {
    const page1 = Array.from({ length: 500 }, (_, n) => ({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    }));
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('page=1&')) return json({ users: page1 });
      if (url.includes('page=2&')) return json({ users: [{ id: A }] });
      const id = url.split('/').pop()!;
      return json({ id, identities: [link(id, 'email')] });
    });
    const users = await readSourceAccounts(BASE, 'svc', fetchFn as unknown as typeof fetch);
    expect(users).toHaveLength(501);
  });

  it('stops when Supabase refuses a read', async () => {
    const fetchFn = vi.fn(async () => json({ msg: 'no' }, 401));
    await expect(
      readSourceAccounts(BASE, 'svc', fetchFn as unknown as typeof fetch),
    ).rejects.toThrow('source read failed: 401');
  });

  it('stops, rather than returning a short list, when a read fails part way', async () => {
    const C = '33333333-3333-4333-8333-333333333333';
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/users?')) return json({ users: [{ id: A }, { id: B }, { id: C }] });
      if (url.endsWith(B)) return json({ msg: 'busy' }, 500);
      const id = url.split('/').pop()!;
      return json({ id, identities: [link(id, 'email')] });
    });
    await expect(
      readSourceAccounts(BASE, 'svc', fetchFn as unknown as typeof fetch),
    ).rejects.toThrow('source read failed: 500');
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('stops when the one-account view answers for a different account', async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.includes('/users?') ? json({ users: [{ id: A }] }) : json({ id: B, identities: [] }),
    );
    await expect(
      readSourceAccounts(BASE, 'svc', fetchFn as unknown as typeof fetch),
    ).rejects.toThrow('source read failed: wrong account');
  });
});
