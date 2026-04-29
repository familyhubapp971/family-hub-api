// Drizzle schema.
//
// Per ADR 0001, every tenant-scoped table carries `tenant_id` and is
// guarded by RLS. The `users` mirror table is the one global exception:
// a user can belong to multiple tenants via tenant_memberships (future
// ticket), so the user row itself has no tenant_id. RLS is still
// enabled on users — the policy is "self-read by authenticated user
// id", which keeps the global-table shape consistent with the rest of
// the schema and stops a misconfigured role from selecting every row.

import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Users mirror table (FHS-192).
 *
 * Mirrors the Supabase-managed `auth.users` row into our `public`
 * schema so app tables can FK to a stable user id. Populated lazily on
 * the first authenticated request — see `apps/api/src/lib/user-mirror.ts`.
 *
 * The `id` column is the same UUID Supabase issued (the JWT `sub`),
 * which means joins back to `auth.users` are direct. `email` is
 * mirrored for convenience and uniqueness; the source of truth for
 * auth-state remains Supabase.
 */
export const users = pgTable('users', {
  // Match the JWT `sub` claim (Supabase auth user id).
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
