// FHS-705: reads every account from Supabase's admin API for the copy tool.
// Supabase's account list leaves out each account's sign-in links (email,
// Google); only the one-account view includes them. Reading the list alone,
// the production practice run saw 35 accounts and 0 links.

import type { SourceUser } from './account-copy.js';

const PAGE_SIZE = 500;

export async function readSourceAccounts(
  base: string,
  key: string,
  fetchFn: typeof fetch = fetch,
): Promise<SourceUser[]> {
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetchFn(`${base}/auth/v1/admin/${path}`, { headers });
    if (!res.ok) throw new Error(`source read failed: ${res.status}`);
    return (await res.json()) as T;
  };

  const listed: SourceUser[] = [];
  for (let page = 1; ; page++) {
    const body = await get<{ users?: SourceUser[] }>(`users?page=${page}&per_page=${PAGE_SIZE}`);
    const batch = body.users ?? [];
    listed.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  const full: SourceUser[] = [];
  for (const { id } of listed) {
    const user = await get<SourceUser>(`users/${encodeURIComponent(id)}`);
    if (user.id !== id) throw new Error('source read failed: wrong account');
    full.push(user);
  }
  return full;
}
