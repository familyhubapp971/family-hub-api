// Drizzle schema.
//
// Per ADR 0001, every tenant-scoped table carries `tenant_id` and is
// guarded by RLS. The `users` mirror table is the one global exception:
// a user can belong to multiple tenants via tenant_memberships (future
// ticket), so the user row itself has no tenant_id. RLS is still
// enabled on users — the policy is "self-read by authenticated user
// id", which keeps the global-table shape consistent with the rest of
// the schema and stops a misconfigured role from selecting every row.

import {
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

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

// ─────────────────────────────────────────────────────────────────────────────
// Tenant-scoped core tables (FHS-3 — Sprint 1, Tenant Foundation).
//
// Plain: every table below belongs to one family. The `tenant_id` column
// is the link back to the tenants row. Deleting a family wipes all its
// rows (ON DELETE CASCADE). RLS policies that enforce this at the DB
// role level land in FHS-8 (Sprint 2 — Tenant Isolation).
//
// Design choices baked in here:
//   - Every PK is uuid + gen_random_uuid() (matches users + tenants).
//   - tenant_id is uuid not null + FK to tenants(id) on delete cascade.
//   - Composite index on (tenant_id, id) on every table — RLS-friendly +
//     the dominant access pattern. Adds (tenant_id, created_at desc) on
//     time-ordered tables.
//   - Minimal columns only. Richer per-feature columns land in the
//     ticket that builds the feature.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Family-member role.
 *
 * `admin`   — full control, billing, can remove other members.
 * `adult`   — full read/write on family content; cannot manage billing or admins.
 * `teen`    — restricted write (no financial actions); broad read.
 * `child`   — limited write (their own habits/actions); restricted read.
 * `guest`   — read-only or invite-only access; placeholder for community share-outs.
 */
export const memberRole = pgEnum('member_role', ['admin', 'adult', 'teen', 'child', 'guest']);

/**
 * `members` — people inside a family.
 *
 * Distinct from `users` (the global Supabase auth identity). A user can
 * be a member of multiple families; an invitee can be a member before
 * they have a `users` row (`user_id` is nullable until they accept).
 */
export const members = pgTable(
  'members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // Nullable: an invitee may exist as a member before signup.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    displayName: text('display_name').notNull(),
    role: memberRole('role').notNull().default('adult'),
    avatarEmoji: text('avatar_emoji'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('members_tenant_id_idx').on(t.tenantId, t.id)],
);

export type Member = typeof members.$inferSelect;
export type NewMember = typeof members.$inferInsert;

/**
 * `weeks` — Mon–Sun tracking unit.
 *
 * Anchors per-week habit/action data. One row per (tenant, start_date).
 * The unique index doubles as a fast lookup for "this week's row".
 */
export const weeks = pgTable(
  'weeks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('weeks_tenant_id_idx').on(t.tenantId, t.id),
    uniqueIndex('weeks_tenant_start_unique').on(t.tenantId, t.startDate),
  ],
);

export type Week = typeof weeks.$inferSelect;
export type NewWeek = typeof weeks.$inferInsert;

/**
 * Habit cadence — how often a habit recurs.
 *
 * `daily`   — tracked per-day inside a week.
 * `weekly`  — single completion per week.
 * `custom`  — caller-defined schedule; interpretation deferred to the feature ticket.
 */
export const habitCadence = pgEnum('habit_cadence', ['daily', 'weekly', 'custom']);

/**
 * `habits` — recurring activity a family tracks.
 *
 * Soft-deleted via `archived_at` so historical week_actions still
 * reference a valid row.
 */
export const habits = pgTable(
  'habits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    cadence: habitCadence('cadence').notNull().default('daily'),
    targetCount: integer('target_count').notNull().default(1),
    color: text('color').notNull().default('#facc15'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('habits_tenant_id_idx').on(t.tenantId, t.id),
    index('habits_tenant_created_idx').on(t.tenantId, t.createdAt),
  ],
);

export type Habit = typeof habits.$inferSelect;
export type NewHabit = typeof habits.$inferInsert;

/**
 * `week_actions` — per-week tracking entry: did `member_id` complete `habit_id`
 * during `week_id`, and how many times.
 *
 * Unique index prevents duplicate entries for the same (week, member, habit).
 */
export const weekActions = pgTable(
  'week_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    weekId: uuid('week_id')
      .notNull()
      .references(() => weeks.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    habitId: uuid('habit_id')
      .notNull()
      .references(() => habits.id, { onDelete: 'cascade' }),
    completedCount: integer('completed_count').notNull().default(0),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('week_actions_tenant_id_idx').on(t.tenantId, t.id),
    uniqueIndex('week_actions_week_member_habit_unique').on(t.weekId, t.memberId, t.habitId),
  ],
);

export type WeekAction = typeof weekActions.$inferSelect;
export type NewWeekAction = typeof weekActions.$inferInsert;

/**
 * `savings` — a family savings goal or account (e.g. "Hajj fund").
 *
 * `target_amount` is nullable — open-ended savings (no goal) is valid.
 * Currency is per-savings to support multi-currency families.
 */
export const savings = pgTable(
  'savings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    targetAmount: numeric('target_amount', { precision: 12, scale: 2 }),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('savings_tenant_id_idx').on(t.tenantId, t.id)],
);

export type Savings = typeof savings.$inferSelect;
export type NewSavings = typeof savings.$inferInsert;

/** Savings transaction direction. */
export const savingsTxType = pgEnum('savings_transaction_type', ['deposit', 'withdrawal']);

/**
 * `savings_transactions` — individual deposit or withdrawal entry.
 *
 * `member_id` is nullable so historical entries survive a member being
 * removed. `occurred_on` is a date (not a timestamp) — savings entries
 * are journal-style by day, not by minute.
 */
export const savingsTransactions = pgTable(
  'savings_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    savingsId: uuid('savings_id')
      .notNull()
      .references(() => savings.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id').references(() => members.id, { onDelete: 'set null' }),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    type: savingsTxType('type').notNull(),
    note: text('note'),
    occurredOn: date('occurred_on').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('savings_transactions_tenant_id_idx').on(t.tenantId, t.id),
    index('savings_transactions_tenant_occurred_idx').on(t.tenantId, t.occurredOn),
  ],
);

export type SavingsTransaction = typeof savingsTransactions.$inferSelect;
export type NewSavingsTransaction = typeof savingsTransactions.$inferInsert;

/** Investment asset class. */
export const investmentAssetType = pgEnum('investment_asset_type', [
  'stock',
  'etf',
  'bond',
  'crypto',
  'real_estate',
  'other',
]);

/**
 * `investments` — family investment position. Placeholder shape; the
 * richer model (lots, prices history, P&L) lands in a later epic.
 */
export const investments = pgTable(
  'investments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    assetType: investmentAssetType('asset_type').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 6 }),
    purchasePrice: numeric('purchase_price', { precision: 18, scale: 6 }),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('investments_tenant_id_idx').on(t.tenantId, t.id)],
);

export type Investment = typeof investments.$inferSelect;
export type NewInvestment = typeof investments.$inferInsert;
