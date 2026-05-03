// Drizzle schema.
//
// Per ADR 0001, every tenant-scoped table carries `tenant_id` and is
// guarded by RLS. The `users` mirror table is the one global exception:
// a user can belong to multiple tenants via tenant_memberships (future
// ticket), so the user row itself has no tenant_id. RLS is still
// enabled on users — the policy is "self-read by authenticated user
// id", which keeps the global-table shape consistent with the rest of
// the schema and stops a misconfigured role from selecting every row.

import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
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
  // Set to true by POST /api/onboarding/complete (FHS-37) once the
  // family finishes the wizard. The /onboarding route bounces back
  // to /dashboard when this is true so a returning user doesn't get
  // the wizard a second time.
  onboardingCompleted: boolean('onboarding_completed').notNull().default(false),
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
 * `pending_invitations` (FHS-91) — outstanding invites awaiting accept.
 *
 * One row per invite *send*. When an admin clicks "invite Sarah" we
 * INSERT a row here with status='pending', then call
 * `supabase.auth.admin.inviteUserByEmail` so Supabase mails the magic
 * link. The redemption endpoint (FHS-92) flips status → 'accepted' and
 * promotes the invite to a real `members` row at the same time.
 *
 * Distinct from `members` rows-with-null-user_id: members represents
 * realised relationships, this represents the paperwork. Decoupling
 * keeps invite-flow metadata (supabase_invite_id, invited_by, status)
 * out of the members table where it would only ever be useful for
 * rows that haven't accepted yet.
 *
 * Tenant-scoped — the unique partial index below blocks a tenant from
 * double-inviting the same email while a previous invite is still
 * pending. Different tenants inviting the same email is fine.
 */
export const invitationStatus = pgEnum('invitation_status', [
  'pending',
  'accepted',
  'revoked',
  'expired',
]);

export const pendingInvitations = pgTable(
  'pending_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // citext would be ideal here but we lean on Postgres lower(email)
    // in the unique index below to make case-insensitive uniqueness
    // work without enabling the citext extension in every environment.
    email: text('email').notNull(),
    role: memberRole('role').notNull().default('adult'),
    // members.id of the person who sent the invite. Nullable because
    // the inviter could be removed from the family later — we still
    // want the invite history.
    invitedBy: uuid('invited_by').references(() => members.id, { onDelete: 'set null' }),
    // Opaque id returned by Supabase admin invite — used by FHS-93/96
    // for revoke + token-expiry checks.
    supabaseInviteId: text('supabase_invite_id'),
    status: invitationStatus('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('pending_invitations_tenant_status_idx').on(t.tenantId, t.status),
    // Partial unique: at most one outstanding (pending) invite per
    // (tenant, email). Accepted/revoked/expired rows don't block a
    // re-invite.
    uniqueIndex('pending_invitations_tenant_email_pending_uniq')
      .on(t.tenantId, sql`lower(${t.email})`)
      .where(sql`status = 'pending'`),
  ],
);

export type PendingInvitation = typeof pendingInvitations.$inferSelect;
export type NewPendingInvitation = typeof pendingInvitations.$inferInsert;

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
 * `rewards` (FHS-40) — items kids can redeem with stickers earned from
 * habits + chores. Each tenant has its own list, seeded with 3 starter
 * rewards on onboarding completion.
 *
 * Soft-delete via `archived_at` so a redeemed reward's history (a
 * future `reward_redemptions` table) still has a valid FK.
 */
export const rewards = pgTable(
  'rewards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    // Stickers required to redeem. Stored as integer; the family
    // earns stickers from habit/chore completion (separate ledger).
    stickerCost: integer('sticker_cost').notNull().default(1),
    // Optional emoji shown next to the reward in the UI.
    icon: text('icon'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rewards_tenant_id_idx').on(t.tenantId, t.id),
    index('rewards_tenant_created_idx').on(t.tenantId, t.createdAt),
  ],
);

export type Reward = typeof rewards.$inferSelect;
export type NewReward = typeof rewards.$inferInsert;

/**
 * Day of the week — Mon-first to align with `weeks.start_date` (also
 * Monday-anchored across the schema).
 */
export const dayOfWeek = pgEnum('day_of_week', ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

/**
 * Meal slot inside a day. The four most-common slots families plan
 * around; if a family doesn't eat lunch at home that's fine — the row
 * just stays empty.
 */
export const mealSlot = pgEnum('meal_slot', ['breakfast', 'lunch', 'dinner', 'snack']);

/**
 * `meal_templates` (FHS-40) — the family's repeating weekly meal plan.
 * One row per (tenant, day_of_week, slot). Seeded EMPTY at onboarding
 * (the AC says "empty weekly meal template") — the table just exists
 * for the UI to write into. The unique partial index keeps each tenant
 * to one row per slot.
 *
 * Per-week meal logs (e.g. "this Tuesday's lunch was actually pizza")
 * are a separate `week_meals` table when that feature ships.
 */
export const mealTemplates = pgTable(
  'meal_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    dayOfWeek: dayOfWeek('day_of_week').notNull(),
    slot: mealSlot('slot').notNull(),
    name: text('name'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('meal_templates_tenant_id_idx').on(t.tenantId, t.id),
    index('meal_templates_tenant_created_idx').on(t.tenantId, t.createdAt),
    uniqueIndex('meal_templates_tenant_day_slot_uniq').on(t.tenantId, t.dayOfWeek, t.slot),
  ],
);

export type MealTemplate = typeof mealTemplates.$inferSelect;
export type NewMealTemplate = typeof mealTemplates.$inferInsert;

/**
 * `events` (FHS-230) — calendar entries on the family Calendar tab.
 * One row per event. `date` is a calendar day (no time zone); the
 * optional `start_time` / `end_time` are HH:MM strings interpreted
 * in the tenant's IANA timezone. `member_id` links the event to a
 * specific family member when set (e.g. "Iman's swimming") and is
 * nullable for whole-family events.
 *
 * Recurring events (weekly, monthly) are deferred — they'll need a
 * separate `event_rules` table when shipped.
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    startTime: text('start_time'),
    endTime: text('end_time'),
    title: text('title').notNull(),
    notes: text('notes'),
    memberId: uuid('member_id').references(() => members.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('events_tenant_id_idx').on(t.tenantId, t.id),
    index('events_tenant_date_idx').on(t.tenantId, t.date),
    index('events_tenant_member_idx').on(t.tenantId, t.memberId),
  ],
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

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

// ─────────────────────────────────────────────────────────────────────────────
// Tenant-scoped content tables (FHS-4 — Sprint 1, Tenant Foundation).
//
// Plain: per-family settings + audit trail. Sprint-1 vertical slice only —
// the original ticket listed 12 feature tables (announcements, school work,
// meals, stickers, etc.) but those land in their own feature PRs alongside
// the UI that exposes them. RLS in FHS-8.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `app_settings` — per-family key/value config.
 *
 * Composite PK on (tenant_id, key): one entry per family per setting key.
 * `value` is jsonb so settings can hold strings, numbers, arrays, or
 * objects without a schema migration. Validation of value shape happens
 * at the api edge (Zod) — the DB only enforces (tenant, key) uniqueness.
 *
 * Examples: ('theme', '"dark"'), ('default_currency', '"AED"'),
 * ('habit_reminders', '{"enabled": true, "time": "20:00"}').
 */
export const appSettings = pgTable(
  'app_settings',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);

export type AppSetting = typeof appSettings.$inferSelect;
export type NewAppSetting = typeof appSettings.$inferInsert;

/**
 * `activity_logs` — append-only audit trail.
 *
 * Both actor columns are nullable: system-generated actions (cron jobs,
 * webhooks) have no actor; member-attributed actions set `actor_member_id`
 * and may also set `actor_user_id`. Cascade-delete on tenant; the actor
 * FKs use SET NULL so deleting an actor preserves the audit trail.
 *
 * `metadata` is jsonb so individual log shapes can vary per action type
 * without schema churn. Index on (tenant_id, created_at desc) for the
 * dominant query: "recent activity for this family".
 */
export const activityLogs = pgTable(
  'activity_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    actorMemberId: uuid('actor_member_id').references(() => members.id, { onDelete: 'set null' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('activity_logs_tenant_created_idx').on(t.tenantId, t.createdAt)],
);

export type ActivityLog = typeof activityLogs.$inferSelect;
export type NewActivityLog = typeof activityLogs.$inferInsert;

/**
 * Registry of every tenant-scoped table. Drives the cross-tenant leak
 * audit (FHS-6) and any future cross-cutting tooling that needs to walk
 * all family-scoped tables. ADD NEW TABLES HERE when they land — the
 * audit test fails loudly if a table with `tenant_id` is missing.
 */
export const TENANT_SCOPED_TABLES = [
  members,
  pendingInvitations,
  weeks,
  habits,
  rewards,
  mealTemplates,
  events,
  weekActions,
  savings,
  savingsTransactions,
  investments,
  appSettings,
  activityLogs,
] as const;
