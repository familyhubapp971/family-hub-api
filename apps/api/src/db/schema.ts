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
  real,
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
  // FHS-445 — per-family secret that signs the calendar "subscribe link"
  // token (HMAC). Null until the family first opens the sync card; rotating
  // it invalidates every existing subscription. Never leaves the server.
  calendarFeedKey: text('calendar_feed_key'),
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
    // FHS-235 — Kid-Auth foundation. `pin_hash` holds a bcrypt hash of
    // the kid's 4-digit PIN (null = no PIN set; parents never have
    // one). `is_child` is an explicit flag for the kid-login flow,
    // decoupled from `role` because a family may want a teen to use
    // PIN-login or an adult-role member to sign in with a PIN — the
    // role enum is about permissions, this flag is about auth flow.
    pinHash: text('pin_hash'),
    isChild: boolean('is_child').notNull().default(false),
    // FHS-276 — optional age (years) shown on kid cards ("Child (6)").
    // Collected by the Manage Members "Add a Child" form; not a birthday,
    // so it goes stale — fine for v1 display purposes.
    age: integer('age'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('members_tenant_id_idx').on(t.tenantId, t.id),
    // Lookup index for the kid-PIN login flow (tenant_slug → kid
    // members in that tenant).
    index('members_tenant_is_child_idx').on(t.tenantId, t.isChild),
  ],
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
    // FHS-275 — the unclaimed member seat this invite belongs to. On
    // first sign-in the claim flow sets members.user_id on THIS row so
    // the invitee becomes the person the wizard created (no duplicate).
    memberId: uuid('member_id').references(() => members.id, { onDelete: 'cascade' }),
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
    // FHS-296 — My World is per-child: a habit belongs to one child so
    // each child's world shows their own habits (nullable only for the
    // legacy family-finance scaffold rows; My World always sets it).
    memberId: uuid('member_id').references(() => members.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    cadence: habitCadence('cadence').notNull().default('daily'),
    targetCount: integer('target_count').notNull().default(1),
    color: text('color').notNull().default('#facc15'),
    // FHS-291 — My World economy: an emoji/lucide key for the habit card,
    // and a bonus flag (bonus habits earn stickerValue 5 instead of 1).
    icon: text('icon'),
    isBonus: boolean('is_bonus').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('habits_tenant_id_idx').on(t.tenantId, t.id),
    index('habits_tenant_member_idx').on(t.tenantId, t.memberId),
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
 * `habit_logs` (FHS-268) — one row per habit a member completed on a
 * given day. Each row is worth one sticker; a member's sticker balance
 * is `count(habit_logs) - sum(reward_redemptions.sticker_cost)`.
 *
 * The unique key makes the kid habit-tracker toggle idempotent: ticking
 * the same (habit, member, day) twice is a no-op insert, un-ticking is a
 * delete on the same key.
 */
export const habitLogs = pgTable(
  'habit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    habitId: uuid('habit_id')
      .notNull()
      .references(() => habits.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    logDate: date('log_date').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('habit_logs_unique_idx').on(t.tenantId, t.habitId, t.memberId, t.logDate),
    index('habit_logs_tenant_member_date_idx').on(t.tenantId, t.memberId, t.logDate),
  ],
);

export type HabitLog = typeof habitLogs.$inferSelect;
export type NewHabitLog = typeof habitLogs.$inferInsert;

/**
 * `reward_redemptions` (FHS-268) — a member spending stickers on a
 * reward. `sticker_cost` snapshots the reward's cost at redemption time
 * so later edits to the reward don't rewrite history. Balance maths reads
 * this sum against the member's `habit_logs` count.
 */
export const rewardRedemptions = pgTable(
  'reward_redemptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    rewardId: uuid('reward_id')
      .notNull()
      .references(() => rewards.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    stickerCost: integer('sticker_cost').notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('reward_redemptions_tenant_member_idx').on(t.tenantId, t.memberId),
    index('reward_redemptions_tenant_reward_idx').on(t.tenantId, t.rewardId),
  ],
);

export type RewardRedemption = typeof rewardRedemptions.$inferSelect;
export type NewRewardRedemption = typeof rewardRedemptions.$inferInsert;

/**
 * Mood values for a journal entry (FHS-270 per-day model).
 *
 * Eight named emotional states chosen by the child. Stored as a pgEnum
 * so invalid values are rejected at the DB level, not just the API edge.
 */
export const journalMood = pgEnum('journal_mood', [
  'happy',
  'smiling',
  'excited',
  'laughing',
  'surprised',
  'nervous',
  'grumpy',
  'sad',
]);

/**
 * `journal_entries` (FHS-270, per-day model) — one row per (tenant, member,
 * calendar day). Upserted by the child-journal UI so the same day always
 * collapses to a single row. All content fields are nullable so a partial
 * save (e.g. mood only) is valid. `quote_index` is set server-side to the
 * deterministic quote-of-the-day index for that `entry_date`.
 *
 * `body` is nullable: legacy rows carried free text, but the per-day model
 * allows mood / gratitude / creativity answers without any body text.
 *
 * Unique index on (tenant_id, member_id, entry_date) enforces one row per
 * day per child, making the upsert ON CONFLICT target unambiguous.
 */
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    // Calendar day (YYYY-MM-DD). Unique per (tenant, member) — one entry per day.
    entryDate: date('entry_date').notNull(),
    // Emotional state for the day.
    mood: journalMood('mood'),
    // Up to three gratitude prompts — nullable; filled in any order.
    gratitude1: text('gratitude1'),
    gratitude2: text('gratitude2'),
    gratitude3: text('gratitude3'),
    // Deterministic quote-of-the-day index (set server-side from entryDate).
    quoteIndex: integer('quote_index'),
    // Answers to creativity questions, keyed by question index.
    // e.g. {"0": "I'd fly!", "3": "Learn everything at once."}
    creativity: jsonb('creativity').$type<Record<string, string>>().default({}),
    // Free-text "what happened today" (nullable — per-day model allows
    // entries with only mood / gratitude / creativity).
    body: text('body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('journal_entries_tenant_member_created_idx').on(t.tenantId, t.memberId, t.createdAt),
    uniqueIndex('journal_entries_tenant_member_date_uniq').on(t.tenantId, t.memberId, t.entryDate),
  ],
);

export type JournalEntry = typeof journalEntries.$inferSelect;
export type NewJournalEntry = typeof journalEntries.$inferInsert;

/**
 * `learn_progress` (FHS-270) — per-subject progress (0–100) for a child's
 * Learn cards. One row per (member, subject); the actual learning content
 * is a separate epic — this just backs the progress bars.
 */
export const learnProgress = pgTable(
  'learn_progress',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    progress: integer('progress').notNull().default(0),
    // FHS-283 — interactive lesson stats, updated as the child answers questions.
    currentStreak: integer('current_streak').notNull().default(0),
    bestStreak: integer('best_streak').notNull().default(0),
    totalCorrect: integer('total_correct').notNull().default(0),
    totalAnswered: integer('total_answered').notNull().default(0),
    certificateAt: timestamp('certificate_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('learn_progress_unique_idx').on(t.tenantId, t.memberId, t.subject)],
);

export type LearnProgress = typeof learnProgress.$inferSelect;
export type NewLearnProgress = typeof learnProgress.$inferInsert;

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
 * `meal_templates` (FHS-40, expanded FHS-264) — the family's repeating
 * weekly meal plan. Seeded EMPTY at onboarding — the table just exists
 * for the UI to write into.
 *
 * FHS-264 adds `member_id` (nullable — null means "everyone") and
 * `recurring` (visual repeat flag). With member_id a single (day, slot)
 * can now hold several meals: one whole-family meal PLUS one per member.
 * Uniqueness is split into two partial indexes so the upsert stays
 * idempotent without depending on Postgres NULLS NOT DISTINCT:
 *   - at most one whole-family row per (tenant, day, slot)   [member_id IS NULL]
 *   - at most one row per (tenant, day, slot, member_id)     [member_id IS NOT NULL]
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
    // FHS-264 — who the meal is for. Null = the whole family. CASCADE on
    // member delete: a removed member's personal meals are removed too.
    // (SET NULL would turn a per-member row into a second whole-family row
    // and could collide with an existing one under the everyone partial
    // unique index — so the meal goes, not the family's slot.)
    memberId: uuid('member_id').references(() => members.id, { onDelete: 'cascade' }),
    // FHS-264 — visual "repeats every week" flag. No scheduling behaviour
    // yet; the UI just shows a repeat icon.
    recurring: boolean('recurring').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('meal_templates_tenant_id_idx').on(t.tenantId, t.id),
    index('meal_templates_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('meal_templates_tenant_member_idx').on(t.tenantId, t.memberId),
    uniqueIndex('meal_templates_tenant_day_slot_everyone_uniq')
      .on(t.tenantId, t.dayOfWeek, t.slot)
      .where(sql`${t.memberId} is null`),
    uniqueIndex('meal_templates_tenant_day_slot_member_uniq')
      .on(t.tenantId, t.dayOfWeek, t.slot, t.memberId)
      .where(sql`${t.memberId} is not null`),
  ],
);

export type MealTemplate = typeof mealTemplates.$inferSelect;
export type NewMealTemplate = typeof mealTemplates.$inferInsert;

/**
 * Calendar split (FHS-265) — School vs Home activities render under
 * separate sub-tabs on the Calendar screen.
 */
export const eventType = pgEnum('event_type', ['school', 'home']);

/**
 * `events` (FHS-230, expanded FHS-265) — calendar entries on the family
 * Calendar tab. One row per event. `date` is a calendar day (no time
 * zone); the optional `start_time` / `end_time` are HH:MM strings
 * interpreted in the tenant's IANA timezone. `member_id` links the
 * event to a specific family member when set (e.g. "Iman's swimming")
 * and is nullable for whole-family events.
 *
 * FHS-265 adds `type` (school | home sub-tab), `location` ("where")
 * and `wear` ("what to wear") — both free text, both optional.
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
    type: eventType('type').notNull().default('home'),
    location: text('location'),
    wear: text('wear'),
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
 * `assignments` (FHS-231) — homework / chores list on the family
 * Assignments tab. One row per task. `due_date` is optional (general
 * "to-do") — when set, lists sort earliest-first. `done_at` toggles
 * completion (timestamp so we can show "completed at" later); UI
 * filters by it. `member_id` assigns the assignment to a specific
 * family member (e.g. "Iman's maths homework") and is nullable for
 * household-wide tasks.
 */
export const assignments = pgTable(
  'assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    notes: text('notes'),
    dueDate: date('due_date'),
    memberId: uuid('member_id').references(() => members.id, { onDelete: 'set null' }),
    doneAt: timestamp('done_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('assignments_tenant_id_idx').on(t.tenantId, t.id),
    index('assignments_tenant_due_idx').on(t.tenantId, t.dueDate),
    index('assignments_tenant_member_idx').on(t.tenantId, t.memberId),
  ],
);

export type Assignment = typeof assignments.$inferSelect;
export type NewAssignment = typeof assignments.$inferInsert;

/**
 * `notices` (FHS-232) — family bulletin board on the Noticeboard tab.
 * Pinned notes float to the top of the feed; everything else is in
 * reverse-chronological order. `author_member_id` records who posted
 * the note (FK set null on member delete so deleting a parent doesn't
 * vaporise their notices).
 */
export const notices = pgTable(
  'notices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    pinned: boolean('pinned').notNull().default(false),
    // FHS-266 — optional single-emoji icon shown on the post-it card.
    icon: text('icon'),
    authorMemberId: uuid('author_member_id').references(() => members.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notices_tenant_id_idx').on(t.tenantId, t.id),
    index('notices_tenant_pinned_created_idx').on(t.tenantId, t.pinned, t.createdAt),
  ],
);

export type Notice = typeof notices.$inferSelect;
export type NewNotice = typeof notices.$inferInsert;

/**
 * `tasks` (FHS-233) — per-member personal to-do list on the Tasks tab.
 * Distinct from `assignments` (family homework): tasks are private to
 * the assigned member; only that member can see / mutate them. The
 * `member_id` FK uses `ON DELETE cascade` because removing a member
 * vaporises their to-do list (no logical owner left).
 */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    dueDate: date('due_date'),
    doneAt: timestamp('done_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tasks_tenant_id_idx').on(t.tenantId, t.id),
    index('tasks_tenant_member_done_idx').on(t.tenantId, t.memberId, t.doneAt),
  ],
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

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

// ─────────────────────────────────────────────────────────────────────────────
// My World economy (FHS-290 epic) — ported from legacy family-hub, scoped
// per (tenant, member) so each child has their own sticker economy. New
// `mw_`-prefixed tables intentionally sit alongside the generic family
// `weeks`/`savings`/`investments` stubs (different semantics). 1 sticker =
// 0.5 AED; bonus habits earn stickerValue 5. See ADR 0014.
// ─────────────────────────────────────────────────────────────────────────────

/** Sticker type a child places on a habit day. */
export const stickerType = pgEnum('sticker_type', ['gold-star', 'heart', 'magic', 'trophy']);

/**
 * `mw_weeks` — a child's trackable week (Monday-anchored ISO week). One
 * open (non-finalized) week per child at a time; closing it creates the
 * next. Carried/retrieved columns record investment maturity + savings
 * withdrawals applied during the week; `closure_snapshot` is a JSON audit.
 */
export const mwWeeks = pgTable(
  'mw_weeks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    weekNumber: integer('week_number').notNull(),
    year: integer('year').notNull(),
    startDate: date('start_date').notNull(),
    isFinalized: boolean('is_finalized').notNull().default(false),
    carriedOverStickers: integer('carried_over_stickers').notNull().default(0),
    carriedOverCash: numeric('carried_over_cash', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    retrievedStickers: integer('retrieved_stickers').notNull().default(0),
    retrievedCash: numeric('retrieved_cash', { precision: 12, scale: 2 }).notNull().default('0'),
    closureSnapshot: jsonb('closure_snapshot'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mw_weeks_member_week_unique').on(t.tenantId, t.memberId, t.year, t.weekNumber),
    index('mw_weeks_member_idx').on(t.tenantId, t.memberId),
  ],
);
export type MwWeek = typeof mwWeeks.$inferSelect;
export type NewMwWeek = typeof mwWeeks.$inferInsert;

/**
 * `habit_stickers` — one sticker placed on a (habit, day) within a week.
 * Replaces the lightweight FHS-268 `habit_logs` tick: each row carries a
 * sticker TYPE + value (5 for bonus habits, else 1) and an `is_allocated`
 * flag set true once the sticker is spent (claim/save/invest).
 */
export const habitStickers = pgTable(
  'habit_stickers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    habitId: uuid('habit_id')
      .notNull()
      .references(() => habits.id, { onDelete: 'cascade' }),
    weekId: uuid('week_id')
      .notNull()
      .references(() => mwWeeks.id, { onDelete: 'cascade' }),
    day: integer('day').notNull(), // 0 = Monday … 6 = Sunday
    sticker: stickerType('sticker').notNull(),
    stickerValue: integer('sticker_value').notNull().default(1),
    isAllocated: boolean('is_allocated').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // member_id is part of the key: two children in one family can share a
    // habit and each hold their own sticker on the same (week, day).
    uniqueIndex('habit_stickers_unique').on(t.tenantId, t.memberId, t.habitId, t.weekId, t.day),
    index('habit_stickers_member_week_idx').on(t.tenantId, t.memberId, t.weekId),
  ],
);
export type HabitSticker = typeof habitStickers.$inferSelect;
export type NewHabitSticker = typeof habitStickers.$inferInsert;

/**
 * `mw_savings` — a child's saved-sticker + saved-cash balance (one row
 * per child). The legacy singleton (id=1) becomes one row per member.
 */
export const mwSavings = pgTable(
  'mw_savings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    savedStickers: integer('saved_stickers').notNull().default(0),
    savedCash: numeric('saved_cash', { precision: 12, scale: 2 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('mw_savings_member_unique').on(t.tenantId, t.memberId)],
);
export type MwSavings = typeof mwSavings.$inferSelect;
export type NewMwSavings = typeof mwSavings.$inferInsert;

/** A My World savings movement: stickers banked, or cash in/out. */
export const mwSavingsTxType = pgEnum('mw_savings_tx_type', ['stickers', 'cash']);

/**
 * `mw_savings_transactions` — ledger of saves/cashouts for a child.
 * `mw_transaction_stickers` links a save to the specific habit_stickers it
 * banked, so a reversal knows which to un-allocate.
 */
export const mwSavingsTransactions = pgTable(
  'mw_savings_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    transactionType: mwSavingsTxType('transaction_type').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    stickerCount: integer('sticker_count').notNull().default(0),
    isReversed: boolean('is_reversed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('mw_savings_tx_member_idx').on(t.tenantId, t.memberId)],
);
export type MwSavingsTransaction = typeof mwSavingsTransactions.$inferSelect;
export type NewMwSavingsTransaction = typeof mwSavingsTransactions.$inferInsert;

/** Junction: which habit_stickers a save transaction banked. */
export const mwTransactionStickers = pgTable(
  'mw_transaction_stickers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => mwSavingsTransactions.id, { onDelete: 'cascade' }),
    stickerId: uuid('sticker_id')
      .notNull()
      .references(() => habitStickers.id, { onDelete: 'cascade' }),
  },
  (t) => [index('mw_transaction_stickers_tx_idx').on(t.transactionId)],
);
export type MwTransactionSticker = typeof mwTransactionStickers.$inferSelect;
export type NewMwTransactionSticker = typeof mwTransactionStickers.$inferInsert;

/**
 * `mw_investments` — a child investing stickers in a habit. Grows +5 per
 * completed day and −2 per missed day (min 10 to invest, one active per
 * habit). Matured value auto-returns to savings on week close unless
 * continued. `original_invested_stickers` keeps the first principal across
 * rollovers for journey tracking.
 */
export const mwInvestments = pgTable(
  'mw_investments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    habitId: uuid('habit_id')
      .notNull()
      .references(() => habits.id, { onDelete: 'cascade' }),
    weekId: uuid('week_id')
      .notNull()
      .references(() => mwWeeks.id, { onDelete: 'cascade' }),
    investedAmount: numeric('invested_amount', { precision: 12, scale: 2 }).notNull(),
    investedStickers: integer('invested_stickers').notNull(),
    originalInvestedStickers: integer('original_invested_stickers').notNull(),
    currentValue: numeric('current_value', { precision: 12, scale: 2 }).notNull().default('0'),
    daysCompleted: integer('days_completed').notNull().default(0),
    daysMissed: integer('days_missed').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    isResolved: boolean('is_resolved').notNull().default(false),
    // FHS-378 — when true (default, legacy behaviour) missed days apply the
    // −2/day penalty; when false the investment still tracks missed days but
    // never loses value for them. Existing rows keep deductible=true.
    deductible: boolean('deductible').notNull().default(true),
    finalReturn: numeric('final_return', { precision: 12, scale: 2 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('mw_investments_member_idx').on(t.tenantId, t.memberId),
    index('mw_investments_active_idx').on(t.tenantId, t.memberId, t.isActive),
  ],
);
export type MwInvestment = typeof mwInvestments.$inferSelect;
export type NewMwInvestment = typeof mwInvestments.$inferInsert;

/** Action recorded against a My World week (audit of the close-week flow). */
export const mwWeekActionType = pgEnum('mw_week_action_type', [
  'claim',
  'cashout',
  'save',
  'invest',
  'withdraw',
  'auto_save',
  'invest_continue',
]);

/**
 * `mw_week_actions` — append-only audit of what a child did with their
 * stickers in a week (claim a reward, cash out, save, invest, withdraw,
 * plus the auto-save / invest-continue entries written at close).
 */
export const mwWeekActions = pgTable(
  'mw_week_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    weekId: uuid('week_id')
      .notNull()
      .references(() => mwWeeks.id, { onDelete: 'cascade' }),
    actionType: mwWeekActionType('action_type').notNull(),
    stickersUsed: integer('stickers_used'),
    cashAmount: numeric('cash_amount', { precision: 12, scale: 2 }),
    rewardName: text('reward_name'),
    habitId: uuid('habit_id').references(() => habits.id, { onDelete: 'set null' }),
    habitName: text('habit_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('mw_week_actions_week_idx').on(t.tenantId, t.weekId)],
);
export type MwWeekAction = typeof mwWeekActions.$inferSelect;
export type NewMwWeekAction = typeof mwWeekActions.$inferInsert;

/**
 * Status of a kid's reward redemption request (FHS-376).
 *
 * `pending`  — the kid asked; awaiting an admin parent's decision.
 * `approved` — an admin approved; the cost was deducted from savings.
 * `declined` — an admin declined; no deduction.
 */
export const redemptionRequestStatus = pgEnum('redemption_request_status', [
  'pending',
  'approved',
  'declined',
]);

/**
 * `redemption_requests` (FHS-376) — a kid asks to spend on a reward; an admin
 * parent approves or declines. The kid's POST /api/kid/rewards/:id/request
 * creates a `pending` row WITHOUT any deduction. An admin's approve deducts
 * `star_cost` from the kid's banked SAVINGS only (not the week's unallocated
 * stickers) and flips the row to `approved`; a decline flips it to `declined`.
 *
 * `star_cost` snapshots the reward's sticker cost at request time so later
 * edits to the reward don't rewrite a pending request's price. `decided_by`
 * records which member (the admin) decided. Tenant-scoped + RLS-guarded like
 * every other My World table.
 */
export const redemptionRequests = pgTable(
  'redemption_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // The kid who requested the reward.
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    rewardId: uuid('reward_id')
      .notNull()
      .references(() => rewards.id, { onDelete: 'cascade' }),
    status: redemptionRequestStatus('status').notNull().default('pending'),
    // Snapshot of the reward's sticker cost when the request was made.
    starCost: integer('star_cost').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    // Set when an admin approves/declines.
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    // The member (admin) who decided. SET NULL so a removed admin keeps history.
    decidedBy: uuid('decided_by').references(() => members.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('redemption_requests_tenant_status_idx').on(t.tenantId, t.status),
    index('redemption_requests_tenant_member_idx').on(t.tenantId, t.memberId),
  ],
);

export type RedemptionRequest = typeof redemptionRequests.$inferSelect;
export type NewRedemptionRequest = typeof redemptionRequests.$inferInsert;

/**
 * `reading_log` — a child's personal book list (Learn Phase 1).
 *
 * One row per book a child adds. Title is required; author is optional.
 * `finished` toggles read/unread. Member-scoped and tenant-scoped so each
 * child has their own list and data never leaks across families.
 */
export const readingLog = pgTable(
  'reading_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    // Nullable — author is optional when adding a book.
    author: text('author'),
    finished: boolean('finished').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('reading_log_tenant_member_created_idx').on(t.tenantId, t.memberId, t.createdAt)],
);

export type ReadingLog = typeof readingLog.$inferSelect;
export type NewReadingLog = typeof readingLog.$inferInsert;

/**
 * `world_flags_progress` (Learn Phase 2a) — tracks which country flags a
 * child has explored. One row per (tenant, member, country code). The
 * UNIQUE constraint on (tenant_id, member_id, country_code) makes the
 * explore POST idempotent via onConflictDoNothing.
 *
 * TODO (later PRs): add quiz attempts table when timed quizzes land.
 */
export const worldFlagsProgress = pgTable(
  'world_flags_progress',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    // ISO 3166-1 alpha-2 (or alpha-3 for Kosovo) country code.
    countryCode: text('country_code').notNull(),
    exploredAt: timestamp('explored_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('world_flags_progress_unique_idx').on(t.tenantId, t.memberId, t.countryCode),
    index('world_flags_progress_member_idx').on(t.tenantId, t.memberId),
  ],
);

export type WorldFlagsProgress = typeof worldFlagsProgress.$inferSelect;
export type NewWorldFlagsProgress = typeof worldFlagsProgress.$inferInsert;

/**
 * `world_flags_learn_progress` (Learn Phase 2b) — tracks completed sets in
 * the structured World Flags Learn path. Each continent is split into sets
 * of 5 countries; passing a set's quiz (100% correct) records its
 * zero-based index here, which unlocks the next set. One row per
 * (tenant, member, continent, chunk index). The UNIQUE constraint makes
 * the learn-complete POST idempotent via onConflictDoNothing.
 */
export const worldFlagsLearnProgress = pgTable(
  'world_flags_learn_progress',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    // Continent name, e.g. "Africa" (matches packages/web data/countries CONTINENTS).
    continent: text('continent').notNull(),
    // Zero-based index of the completed set of 5 countries within the continent.
    chunkIndex: integer('chunk_index').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('world_flags_learn_progress_unique_idx').on(
      t.tenantId,
      t.memberId,
      t.continent,
      t.chunkIndex,
    ),
    index('world_flags_learn_progress_member_idx').on(t.tenantId, t.memberId),
  ],
);

export type WorldFlagsLearnProgress = typeof worldFlagsLearnProgress.$inferSelect;
export type NewWorldFlagsLearnProgress = typeof worldFlagsLearnProgress.$inferInsert;

/**
 * `mw_maths_progress` (FHS-394) — per-kid stage completion for each
 * maths operation × table number. One row per (tenant, member, operation,
 * table_number). The UNIQUE constraint makes PUT upserts idempotent via
 * onConflictDoUpdate. RLS: tenant_isolation policy gates all reads/writes.
 */
export const mwMathsProgress = pgTable(
  'mw_maths_progress',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    // 'addition' | 'subtraction' | 'multiplication' | 'division'
    operation: text('operation').notNull(),
    // 1–12 (times-table number)
    tableNumber: integer('table_number').notNull(),
    learnCompleted: boolean('learn_completed').notNull().default(false),
    practiceCorrect: integer('practice_correct').notNull().default(0),
    proveScore: integer('prove_score').notNull().default(0),
    // Postgres REAL (4-byte float) — matches legacy schema.
    proveAvgTime: real('prove_avg_time').notNull().default(0),
    placementUnlocked: boolean('placement_unlocked').notNull().default(false),
    // FHS-401 — cumulative accuracy counters accumulated from PUT body.
    // total_correct += practiceCorrect (practice) or proveScore (prove) per call.
    // total_attempts += practiceAttempts (always 10) or proveAttempts per call.
    // Separate from per-session fields (practiceCorrect/proveScore) that gate
    // stage completion — these are lifetime sums for the Insights accuracy %.
    totalCorrect: integer('total_correct').notNull().default(0),
    totalAttempts: integer('total_attempts').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex('mw_maths_progress_unique_idx').on(
      t.tenantId,
      t.memberId,
      t.operation,
      t.tableNumber,
    ),
    index('mw_maths_progress_member_idx').on(t.tenantId, t.memberId),
  ],
);

export type MwMathsProgress = typeof mwMathsProgress.$inferSelect;
export type NewMwMathsProgress = typeof mwMathsProgress.$inferInsert;

/**
 * `mw_maths_certificates` (FHS-394) — per-kid achievement certificates for
 * each operation × difficulty. `difficulty` stores the stringified table
 * number ('1'..'12') for placement certs, or 'easy'|'medium'|'hard' for
 * learn-mode certs. One row per (tenant, member, operation, difficulty); the
 * UNIQUE constraint makes POST idempotent via onConflictDoNothing. RLS:
 * tenant_isolation policy gates all reads/writes.
 */
export const mwMathsCertificates = pgTable(
  'mw_maths_certificates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    operation: text('operation').notNull(),
    // Stringified table number '1'..'12' or 'easy'|'medium'|'hard'.
    difficulty: text('difficulty').notNull(),
    totalCorrect: integer('total_correct').notNull(),
    earnedAt: timestamp('earned_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex('mw_maths_certificates_unique_idx').on(
      t.tenantId,
      t.memberId,
      t.operation,
      t.difficulty,
    ),
    index('mw_maths_certificates_member_idx').on(t.tenantId, t.memberId),
  ],
);

export type MwMathsCertificates = typeof mwMathsCertificates.$inferSelect;
export type NewMwMathsCertificates = typeof mwMathsCertificates.$inferInsert;

/**
 * `mw_logic_progress` (FHS-395) — per-kid correct-answer count for each
 * logic game_type × difficulty. One row per (tenant, member, game_type,
 * difficulty). correct_count is incremented server-side on each correct
 * answer; reaching CERTIFICATE_THRESHOLD (10) triggers a certificate insert.
 * RLS: tenant_isolation policy gates all reads/writes.
 */
export const mwLogicProgress = pgTable(
  'mw_logic_progress',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    // 'truefalse' | 'patterns' | 'oddoneout' | 'ifthen' | 'sorting'
    gameType: text('game_type').notNull(),
    // 'easy' | 'medium' | 'hard'
    difficulty: text('difficulty').notNull(),
    correctCount: integer('correct_count').notNull().default(0),
    // FHS-401 — cumulative attempt counter incremented on EVERY answer (correct or wrong).
    // Enables per-subject accuracy = sum(correctCount) / sum(totalAttempts).
    totalAttempts: integer('total_attempts').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex('mw_logic_progress_unique_idx').on(
      t.tenantId,
      t.memberId,
      t.gameType,
      t.difficulty,
    ),
    index('mw_logic_progress_member_idx').on(t.tenantId, t.memberId),
  ],
);

export type MwLogicProgress = typeof mwLogicProgress.$inferSelect;
export type NewMwLogicProgress = typeof mwLogicProgress.$inferInsert;

/**
 * `mw_logic_certificates` (FHS-395) — per-kid achievement certificates for
 * each game_type × difficulty. Awarded server-side when correct_count reaches
 * CERTIFICATE_THRESHOLD (10). The UNIQUE constraint makes inserts idempotent
 * via onConflictDoNothing. RLS: tenant_isolation policy gates all reads/writes.
 */
export const mwLogicCertificates = pgTable(
  'mw_logic_certificates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    gameType: text('game_type').notNull(),
    difficulty: text('difficulty').notNull(),
    totalCorrect: integer('total_correct').notNull(),
    earnedAt: timestamp('earned_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex('mw_logic_certificates_unique_idx').on(
      t.tenantId,
      t.memberId,
      t.gameType,
      t.difficulty,
    ),
    index('mw_logic_certificates_member_idx').on(t.tenantId, t.memberId),
  ],
);

export type MwLogicCertificates = typeof mwLogicCertificates.$inferSelect;
export type NewMwLogicCertificates = typeof mwLogicCertificates.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// Beta feedback (FHS-418)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `beta_feedback` — one submission per survey response from an authenticated user.
 *
 * All survey fields are nullable; the API enforces that at least one is present.
 * `submitted_by_email` is a snapshot of the user's email at submission time for
 * easy export without a join back to `users`.
 */
export const betaFeedback = pgTable(
  'beta_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // users-mirror id of the submitter (nullable: user row could be removed).
    submittedByUserId: uuid('submitted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    // Email snapshot for easy CSV export without a join.
    submittedByEmail: text('submitted_by_email'),
    // PMF survey — "How disappointed would you be if you could no longer use FamilyHub?"
    pmfDisappointment: text('pmf_disappointment'),
    // NPS-style 0–10 recommend score.
    recommendScore: integer('recommend_score'),
    // Likert 1–5 scales.
    solvesProblem: integer('solves_problem'),
    easeOfUse: integer('ease_of_use'),
    keepUsing: integer('keep_using'),
    // Free-text fields (capped at 2000 chars at the API layer).
    painPoint: text('pain_point'),
    featureRequest: text('feature_request'),
    otherFeedback: text('other_feedback'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('beta_feedback_tenant_id_idx').on(t.tenantId, t.id),
    index('beta_feedback_tenant_created_idx').on(t.tenantId, t.createdAt),
  ],
);

export type BetaFeedback = typeof betaFeedback.$inferSelect;
export type NewBetaFeedback = typeof betaFeedback.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// Public feedback (FHS-429)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `public_feedback` — survey submissions from anonymous (logged-out) visitors
 * on the public homepage. No tenant_id: these users have no family/account.
 *
 * RLS is intentionally disabled on this table — it is NOT tenant-scoped and
 * app_runtime can INSERT freely. The DEFAULT PRIVILEGES grant in migration
 * 0027 covers the table automatically.
 */
export const publicFeedback = pgTable('public_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name'),
  email: text('email'),
  pmfDisappointment: text('pmf_disappointment'),
  recommendScore: integer('recommend_score'),
  solvesProblem: integer('solves_problem'),
  easeOfUse: integer('ease_of_use'),
  keepUsing: integer('keep_using'),
  painPoint: text('pain_point'),
  featureRequest: text('feature_request'),
  otherFeedback: text('other_feedback'),
  source: text('source').notNull().default('public'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PublicFeedback = typeof publicFeedback.$inferSelect;
export type NewPublicFeedback = typeof publicFeedback.$inferInsert;

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
  habitLogs,
  rewardRedemptions,
  redemptionRequests,
  journalEntries,
  learnProgress,
  mealTemplates,
  events,
  assignments,
  notices,
  tasks,
  weekActions,
  savings,
  savingsTransactions,
  investments,
  mwWeeks,
  habitStickers,
  mwSavings,
  mwSavingsTransactions,
  mwInvestments,
  mwWeekActions,
  appSettings,
  activityLogs,
  readingLog,
  worldFlagsProgress,
  worldFlagsLearnProgress,
  mwMathsProgress,
  mwMathsCertificates,
  mwLogicProgress,
  mwLogicCertificates,
  betaFeedback,
] as const;
