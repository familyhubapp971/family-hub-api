import { describe, it, expect } from 'vitest';
import {
  IDENTITY_COLUMNS,
  INSTANCE_ID,
  USER_COLUMNS,
  identitiesByProvider,
  identityRows,
  missingIds,
  userRow,
  usersWithoutLinks,
  type SourceUser,
} from '../../../../src/security/account-copy.js';

// FHS-699: copying accounts into our GoTrue must keep every id exactly.

const google: SourceUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'parent@example.com',
  email_confirmed_at: '2026-09-01T10:00:00Z',
  app_metadata: { provider: 'google', providers: ['google'] },
  user_metadata: { full_name: 'A Parent' },
  created_at: '2026-09-01T10:00:00Z',
  identities: [
    {
      identity_id: '22222222-2222-4222-8222-222222222222',
      id: 'google-sub-123',
      user_id: '11111111-1111-4111-8111-111111111111',
      identity_data: { sub: 'google-sub-123', email: 'parent@example.com' },
      provider: 'google',
    },
  ],
};

const col = (cols: readonly string[], row: unknown[], name: string) => row[cols.indexOf(name)];

describe('FHS-699: account copy mapping', () => {
  it('keeps the account id and fills the fields GoTrue needs', () => {
    const row = userRow(google);
    expect(row).toHaveLength(USER_COLUMNS.length);
    expect(col(USER_COLUMNS, row, 'id')).toBe(google.id);
    expect(col(USER_COLUMNS, row, 'instance_id')).toBe(INSTANCE_ID);
    expect(col(USER_COLUMNS, row, 'aud')).toBe('authenticated');
    expect(JSON.parse(col(USER_COLUMNS, row, 'raw_user_meta_data') as string)).toEqual({
      full_name: 'A Parent',
    });
  });

  it('writes empty text, never blanks, in the token fields GoTrue reads as strings', () => {
    const row = userRow({ id: google.id });
    for (const name of [
      'confirmation_token',
      'recovery_token',
      'email_change_token_new',
      'email_change',
    ]) {
      expect(col(USER_COLUMNS, row, name), name).toBe('');
    }
  });

  it('keeps each Google link on the same account and provider id', () => {
    const [link] = identityRows(google);
    expect(link).toHaveLength(IDENTITY_COLUMNS.length);
    expect(col(IDENTITY_COLUMNS, link!, 'id')).toBe('22222222-2222-4222-8222-222222222222');
    expect(col(IDENTITY_COLUMNS, link!, 'user_id')).toBe(google.id);
    expect(col(IDENTITY_COLUMNS, link!, 'provider_id')).toBe('google-sub-123');
    expect(col(IDENTITY_COLUMNS, link!, 'provider')).toBe('google');
  });

  it('never leaves the dates GoTrue requires blank', () => {
    const user = userRow({ id: google.id });
    expect(col(USER_COLUMNS, user, 'created_at')).toEqual(expect.any(String));
    expect(col(USER_COLUMNS, user, 'updated_at')).toEqual(expect.any(String));
    const [link] = identityRows({
      ...google,
      updated_at: '2026-10-30T10:00:00Z',
      identities: [{ id: 'g', user_id: google.id, provider: 'google' }],
    });
    expect(col(IDENTITY_COLUMNS, link!, 'created_at')).toBe(google.created_at);
    expect(col(IDENTITY_COLUMNS, link!, 'updated_at')).toBe('2026-10-30T10:00:00Z');
  });

  it('gives a link with no id of its own a fresh one', () => {
    const [link] = identityRows({
      ...google,
      identities: [{ ...google.identities![0]!, identity_id: undefined }],
    });
    expect(col(IDENTITY_COLUMNS, link!, 'id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('counts sign-in links per provider', () => {
    const emailOnly: SourceUser = {
      id: '33333333-3333-4333-8333-333333333333',
      identities: [{ id: 'x', user_id: 'x', provider: 'email' }],
    };
    expect(identitiesByProvider([google, emailOnly, { id: 'y' }])).toEqual({ google: 1, email: 1 });
  });

  it('finds app accounts that would have no sign-in account to copy', () => {
    expect(missingIds(['a', 'b', 'c'], ['a', 'c'])).toEqual(['b']);
    expect(missingIds(['a'], ['a'])).toEqual([]);
  });
});

describe('FHS-705: usersWithoutLinks', () => {
  it('names the accounts with no sign-in link, which nobody could sign in to', () => {
    const bare: SourceUser = { id: '33333333-3333-4333-8333-333333333333', identities: [] };
    const missing: SourceUser = { id: '44444444-4444-4444-8444-444444444444' };
    expect(usersWithoutLinks([google, bare, missing])).toEqual([bare.id, missing.id]);
  });
});
