// FHS-699: maps accounts read from Supabase's admin API into rows for our own
// GoTrue's auth.users and auth.identities, keeping every id exactly. Families,
// roles and history hang off users.id in our database, so a renumbered account
// would fail to sign in. Pure functions: the copy script does the I/O.

import { randomUUID } from 'node:crypto';

export interface SourceIdentity {
  identity_id?: string;
  id: string; // the provider's own id for this person (Google's "sub")
  user_id: string;
  identity_data?: Record<string, unknown> | null;
  provider: string;
  last_sign_in_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface SourceUser {
  id: string;
  aud?: string | null;
  role?: string | null;
  email?: string | null;
  email_confirmed_at?: string | null;
  invited_at?: string | null;
  last_sign_in_at?: string | null;
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
  banned_until?: string | null;
  is_anonymous?: boolean | null;
  identities?: SourceIdentity[] | null;
}

export const INSTANCE_ID = '00000000-0000-0000-0000-000000000000';

/** Column order for the auth.users insert; values() below follows it. */
export const USER_COLUMNS = [
  'instance_id',
  'id',
  'aud',
  'role',
  'email',
  'email_confirmed_at',
  'invited_at',
  'last_sign_in_at',
  'raw_app_meta_data',
  'raw_user_meta_data',
  'created_at',
  'updated_at',
  'banned_until',
  'is_anonymous',
  // GoTrue reads these as plain strings; NULL makes sign-in fail with
  // "converting NULL to string is unsupported", so they must be ''.
  'confirmation_token',
  'recovery_token',
  'email_change_token_new',
  'email_change',
] as const;

export const IDENTITY_COLUMNS = [
  'id',
  'provider_id',
  'user_id',
  'identity_data',
  'provider',
  'last_sign_in_at',
  'created_at',
  'updated_at',
] as const;

// GoTrue reads created_at and updated_at as required dates; a blank one makes
// it fail to load the account ("Database error finding user"), found in the
// FHS-699 rehearsal. Fall back to the nearest known date, else now.
function stamp(...candidates: (string | null | undefined)[]): string {
  return candidates.find((c): c is string => Boolean(c)) ?? new Date().toISOString();
}

export function userRow(u: SourceUser): unknown[] {
  return [
    INSTANCE_ID,
    u.id,
    u.aud ?? 'authenticated',
    u.role ?? 'authenticated',
    u.email ?? null,
    u.email_confirmed_at ?? null,
    u.invited_at ?? null,
    u.last_sign_in_at ?? null,
    JSON.stringify(u.app_metadata ?? {}),
    JSON.stringify(u.user_metadata ?? {}),
    stamp(u.created_at),
    stamp(u.updated_at, u.created_at),
    u.banned_until ?? null,
    u.is_anonymous ?? false,
    '',
    '',
    '',
    '',
  ];
}

export function identityRows(u: SourceUser): unknown[][] {
  return (u.identities ?? []).map((i) => [
    i.identity_id ?? randomUUID(),
    i.id,
    u.id,
    JSON.stringify(i.identity_data ?? {}),
    i.provider,
    i.last_sign_in_at ?? null,
    stamp(i.created_at, u.created_at),
    stamp(i.updated_at, i.created_at, u.updated_at, u.created_at),
  ]);
}

/** Identity counts per provider, e.g. { email: 40, google: 12 }. */
export function identitiesByProvider(users: SourceUser[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const u of users) {
    for (const i of u.identities ?? []) counts[i.provider] = (counts[i.provider] ?? 0) + 1;
  }
  return counts;
}

/** FHS-705: ids of accounts with no sign-in link, which nobody could sign in to. */
export function usersWithoutLinks(users: SourceUser[]): string[] {
  return users.filter((u) => (u.identities ?? []).length === 0).map((u) => u.id);
}

/** Ids present in `required` but missing from `available`. */
export function missingIds(required: Iterable<string>, available: Iterable<string>): string[] {
  const have = new Set(available);
  return [...required].filter((id) => !have.has(id));
}
