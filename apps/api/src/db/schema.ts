// Drizzle schema.
//
// Per ADR 0001, every tenant-scoped table carries `tenant_id` and is
// guarded by RLS. The `users` mirror table is the one global exception:
// a user can belong to multiple tenants via tenant_memberships (future
// ticket), so the user row itself has no tenant_id. RLS is still
// enabled on users — the policy is "self-read by authenticated user
// id", which keeps the global-table shape consistent with the rest of
// the schema and stops a misconfigured role from selecting every row.

import { pgEnum, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

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

/**
 * Tenant lifecycle status.
 *
 * `active` — paying or in trial; full feature surface.
 * `suspended` — admin-paused (billing failure, abuse review). Reads
 *   blocked by RLS; writes blocked at the api edge.
 * `archived` — soft-deleted by the family. Hidden from listings but
 *   data preserved for export / restore window (TBD).
 */
export const tenantStatus = pgEnum('tenant_status', ['active', 'suspended', 'archived']);

/**
 * Tenants table (FHS-2 — Tenant Foundation).
 *
 * One row per family. Every other family-scoped table in Sprint 1+
 * carries a `tenant_id` foreign key to this row, guarded by Postgres
 * RLS per ADR 0001.
 *
 * **id is UUID**, deviating from the original FHS-2 ticket (which
 * said `serial` for "continuity with the legacy family-hub pattern").
 * UUIDs align with our existing `users` table convention, prevent
 * tenant-count enumeration through the URL, and survive the
 * staging-Postgres-wipe + cross-environment scenarios in ADR 0008
 * without sequence-conflict pain. The "default" tenant carries a
 * fixed UUID (SEED_DEFAULT_TENANT_ID) so seeds + tests can reference
 * it without lookups.
 *
 * **slug** is the subdomain segment per ADR 0002:
 * `<slug>.familyhub.app`. Capped at 63 chars (DNS label limit) and
 * unique-indexed.
 */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  // 63 chars is the DNS label cap; we constrain at the schema level
  // so a too-long slug fails at insert-time, not at first DNS lookup.
  slug: varchar('slug', { length: 63 }).notNull().unique(),
  name: text('name').notNull(),
  status: tenantStatus('status').notNull().default('active'),
  // Stripe plan key (ADR 0004) — `starter | growth | scale | enterprise`.
  // Stored as text rather than an enum so adding a tier doesn't require
  // a schema migration; values validated at the api edge by Zod.
  plan: text('plan').notNull().default('starter'),
  // IANA TZ string (e.g. "Asia/Dubai"). Default to UTC; UI surfaces
  // a picker on family setup (Sprint 1 onboarding).
  timezone: text('timezone').notNull().default('UTC'),
  // ISO 4217 currency code (e.g. "AED", "USD"). Drives Stripe + UI.
  currency: varchar('currency', { length: 3 }).notNull().default('USD'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

/**
 * Deterministic UUID for the seeded "default" family. Lets local dev,
 * tests, and the seed script reference the same row across runs
 * without lookups. Frozen here once-and-for-all; do NOT use this as
 * a real-customer id — the seed only inserts it on empty staging/dev DBs.
 */
export const SEED_DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
