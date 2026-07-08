#!/usr/bin/env node
// FHS-460 — seeds N synthetic "loadtest-" tenants with REAL rows across
// the tables a family actually reads (events, tasks, habits, stickers,
// meals, savings) and writes a fixtures JSON the k6 scenarios log in
// with. An empty tenant makes every GET return an empty array, which
// tells you nothing about real-world latency — a family with 40 events,
// 25 tasks, and 16 habits behaves very differently under load.
//
// WHAT THIS CANNOT DO — parent (Supabase) accounts. Supabase Auth users
// are created via the Supabase Admin API, not this database, and this
// script deliberately carries no Supabase credentials. So it fully
// seeds the KID path (no external dependency — the priority per
// FHS-460) and prints/records the manual step to link a Supabase parent
// account afterwards. See the console output at the end, and
// tests/performance/README.md.
//
// Usage:
//   node tests/performance/scripts/seed-load-tenants.mjs [tenantCount] [fixturesOutPath]
//   node tests/performance/scripts/seed-load-tenants.mjs 3
//   node tests/performance/scripts/seed-load-tenants.mjs 5 tests/performance/fixtures/load-tenants.json
//
// Reads DATABASE_URL from the environment, falling back to .env.local
// (same simple parse as scripts/export-beta-feedback.mjs). Connects as
// the DB OWNER — bypasses RLS — mirroring
// tests/integration/support/seed-tenant-tables.ts, which seeds with the
// superuser connection for the same reason: RLS would otherwise block
// writes with no tenant GUC set.
//
// Safety: every tenant slug is prefixed 'loadtest-<runId>-' so seeded
// rows are trivially identifiable and safe to bulk-delete later:
//   DELETE FROM tenants WHERE slug LIKE 'loadtest-%';   -- cascades everywhere
//
// Zero-install: uses the `pg` and `bcryptjs` packages already in the
// repo's root devDependencies (raw SQL, not the Drizzle schema — that's
// TypeScript and this is a plain zero-build node script, same tradeoff
// scripts/export-beta-feedback.mjs already made).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import bcrypt from 'bcryptjs';

// ── Load DATABASE_URL from .env.local (simple KEY=VALUE parse) ────────────
try {
  const env = readFileSync(new URL('../../../.env.local', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {
  /* no .env.local — rely on the ambient environment (e.g. a staging shell) */
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL not set (add it to .env.local, or export it for staging).');
  process.exit(1);
}

const tenantCount = Number.parseInt(process.argv[2] ?? '3', 10);
const fixturesOutPath = process.argv[3] ?? 'tests/performance/fixtures/load-tenants.json';
if (!Number.isInteger(tenantCount) || tenantCount < 1) {
  console.error(`invalid tenant count: "${process.argv[2]}" (expected a positive integer)`);
  process.exit(1);
}

// Same bcrypt cost the api uses for kid PINs (apps/api/src/routes/
// auth-kid-pin.ts KID_PIN_BCRYPT_COST) so the seeded hash is shaped
// exactly like a production one. Every seeded kid gets the SAME known
// PIN — fine, these are throwaway synthetic tenants, not real families.
const KID_PIN_BCRYPT_COST = 10;
const KID_PIN = '1234';
const KID_PIN_HASH = bcrypt.hashSync(KID_PIN, KID_PIN_BCRYPT_COST);

// Groups one run's tenants under a shared, purgeable slug prefix.
const runId = randomBytes(3).toString('hex');

const HABIT_POOL = [
  { name: 'Brush teeth', icon: '🦷', isBonus: false },
  { name: 'Make bed', icon: '🛏️', isBonus: false },
  { name: 'Read 20 minutes', icon: '📖', isBonus: false },
  { name: 'Tidy room', icon: '🧸', isBonus: false },
  { name: 'Homework done', icon: '📝', isBonus: false },
  { name: 'Kind to sibling', icon: '💛', isBonus: true },
  { name: 'Practice instrument', icon: '🎹', isBonus: false },
  { name: 'Help with dishes', icon: '🍽️', isBonus: true },
];
const STICKER_TYPES = ['gold-star', 'heart', 'magic', 'trophy'];
const DAY_OF_WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MEAL_POOL = [
  'Pancakes',
  'Chicken & rice',
  'Pasta bake',
  'Grilled salmon',
  'Veggie stir-fry',
  'Tacos',
  'Soup & bread',
];
const EVENT_TITLES = [
  'Football practice',
  'Piano lesson',
  'Dentist appointment',
  'School trip',
  'Playdate',
  'Swimming lesson',
  'Birthday party',
  'Parent-teacher meeting',
];
const TASK_TITLES = [
  'Pack school bag',
  'Feed the pet',
  'Water the plants',
  'Clean room',
  'Take out recycling',
  'Homework: maths sheet',
  'Practice spelling words',
  'Pack gym kit',
];

function randomInt(min, maxInclusive) {
  return min + Math.floor(Math.random() * (maxInclusive - min + 1));
}
function pick(arr) {
  return arr[randomInt(0, arr.length - 1)];
}
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
// Mirrors apps/api/src/lib/myworld.ts mondayOf()/isoWeek() exactly, so the
// seeded "current" mw_weeks row is the SAME row GET /api/kid/habits (no
// ?weekId) will look up (or auto-create) as "this week".
function mondayOf(d) {
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const shift = day === 0 ? -6 : 1 - day;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + shift));
}
function isoWeek(d) {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const year = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  const weekNumber = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return { weekNumber, year };
}

const client = new pg.Client({ connectionString });
await client.connect();

async function insertOne(table, columns, values) {
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING id`;
  const { rows } = await client.query(sql, values);
  return rows[0].id;
}

async function seedTenant(index) {
  const tenantSlug = `loadtest-${runId}-${index}`;
  const tenantId = await insertOne(
    'tenants',
    ['slug', 'name', 'onboarding_completed', 'currency'],
    [tenantSlug, `Load Test Family ${runId}-${index}`, true, 'USD'],
  );

  const adminMemberId = await insertOne(
    'members',
    ['tenant_id', 'display_name', 'role', 'is_child'],
    [tenantId, 'Admin Parent', 'admin', false],
  );

  const kidNames = ['Kid A', 'Kid B'];
  const kidAges = [8, 12];
  const kidMemberIds = [];
  for (let k = 0; k < kidNames.length; k += 1) {
    const memberId = await insertOne(
      'members',
      ['tenant_id', 'display_name', 'role', 'is_child', 'pin_hash', 'age'],
      [tenantId, kidNames[k], 'child', true, KID_PIN_HASH, kidAges[k]],
    );
    kidMemberIds.push(memberId);
  }
  const allMemberIds = [adminMemberId, ...kidMemberIds];

  // ── events (~40, spread across the surrounding ~6 weeks) ───────────────
  const today = new Date();
  for (let i = 0; i < 40; i += 1) {
    const offsetDays = randomInt(-21, 21); // 3 weeks back to 3 weeks ahead
    const date = new Date(today.getTime() + offsetDays * 86_400_000);
    // Mostly assigned to one kid; some family-wide (member_id null).
    const memberId = Math.random() < 0.3 ? null : pick(kidMemberIds);
    await client.query(
      `INSERT INTO events (tenant_id, date, title, type, member_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        tenantId,
        isoDate(date),
        pick(EVENT_TITLES),
        Math.random() < 0.5 ? 'school' : 'home',
        memberId,
      ],
    );
  }

  // ── tasks (~25) ──────────────────────────────────────────────────────
  for (let i = 0; i < 25; i += 1) {
    const memberId = pick(allMemberIds);
    const done = Math.random() < 0.4;
    const dueOffset = randomInt(-7, 14);
    const dueDate = isoDate(new Date(today.getTime() + dueOffset * 86_400_000));
    await client.query(
      `INSERT INTO tasks (tenant_id, member_id, title, due_date, done_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, memberId, pick(TASK_TITLES), dueDate, done ? new Date() : null],
    );
  }

  // ── meals — whole-family breakfast + dinner every day, plus a couple of
  //    per-kid lunches. Respects the two partial-unique constraints on
  //    meal_templates (member_id IS NULL vs IS NOT NULL — see schema.ts). ──
  for (const day of DAY_OF_WEEK) {
    await client.query(
      `INSERT INTO meal_templates (tenant_id, day_of_week, slot, name)
       VALUES ($1, $2, 'breakfast', $3)`,
      [tenantId, day, pick(MEAL_POOL)],
    );
    await client.query(
      `INSERT INTO meal_templates (tenant_id, day_of_week, slot, name)
       VALUES ($1, $2, 'dinner', $3)`,
      [tenantId, day, pick(MEAL_POOL)],
    );
  }
  for (const kidMemberId of kidMemberIds) {
    await client.query(
      `INSERT INTO meal_templates (tenant_id, day_of_week, slot, name, member_id)
       VALUES ($1, $2, 'lunch', $3, $4)`,
      [tenantId, pick(DAY_OF_WEEK), pick(MEAL_POOL), kidMemberId],
    );
  }

  // ── habits (8 per kid) + a current + previous mw_weeks row per kid,
  //    then ~30 habit_stickers per kid on the CURRENT week (60 total) ────
  const monday = mondayOf(today);
  const { weekNumber, year } = isoWeek(monday);
  const prevMonday = new Date(monday.getTime() - 7 * 86_400_000);
  const { weekNumber: prevWeekNumber, year: prevYear } = isoWeek(prevMonday);

  for (const kidMemberId of kidMemberIds) {
    const habitIds = [];
    for (const h of HABIT_POOL) {
      const habitId = await insertOne(
        'habits',
        ['tenant_id', 'member_id', 'name', 'icon', 'is_bonus'],
        [tenantId, kidMemberId, h.name, h.icon, h.isBonus],
      );
      habitIds.push({ id: habitId, isBonus: h.isBonus });
    }

    const currentWeekId = await insertOne(
      'mw_weeks',
      ['tenant_id', 'member_id', 'week_number', 'year', 'start_date', 'is_finalized'],
      [tenantId, kidMemberId, weekNumber, year, isoDate(monday), false],
    );
    await insertOne(
      'mw_weeks',
      ['tenant_id', 'member_id', 'week_number', 'year', 'start_date', 'is_finalized'],
      [tenantId, kidMemberId, prevWeekNumber, prevYear, isoDate(prevMonday), true],
    );

    // 30 unique (habit, day) placements out of the 8*7=56 slots the
    // unique index (tenant_id, member_id, habit_id, week_id, day) allows.
    const slots = [];
    for (const h of habitIds) {
      for (let day = 0; day < 7; day += 1) slots.push({ habitId: h.id, day, isBonus: h.isBonus });
    }
    for (let i = slots.length - 1; i > 0; i -= 1) {
      const j = randomInt(0, i);
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    for (const slot of slots.slice(0, 30)) {
      const sticker = pick(STICKER_TYPES);
      await client.query(
        `INSERT INTO habit_stickers (tenant_id, member_id, habit_id, week_id, day, sticker, sticker_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tenantId,
          kidMemberId,
          slot.habitId,
          currentWeekId,
          slot.day,
          sticker,
          slot.isBonus ? 5 : 1,
        ],
      );
    }

    // ── a few banked stickers + their cash equivalent (0.5/sticker,
    //    same STICKER_TO_CASH constant as apps/api/src/lib/myworld.ts) ────
    const savedStickers = randomInt(5, 25);
    await client.query(
      `INSERT INTO mw_savings (tenant_id, member_id, saved_stickers, saved_cash)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, kidMemberId, savedStickers, (savedStickers * 0.5).toFixed(2)],
    );
  }

  // ── a family (whole-family, not per-kid) savings goal ─────────────────
  const savingsId = await insertOne(
    'savings',
    ['tenant_id', 'name', 'target_amount'],
    [tenantId, 'Family Trip Fund', '2000.00'],
  );
  await client.query(
    `INSERT INTO savings_transactions (tenant_id, savings_id, amount, type, occurred_on)
     VALUES ($1, $2, $3, 'deposit', $4)`,
    [tenantId, savingsId, '150.00', isoDate(today)],
  );

  return { tenantSlug, tenantId, adminMemberId, kidMemberIds, kidNames };
}

console.error(`Seeding ${tenantCount} synthetic tenant(s), run id "${runId}"...`);
const results = [];
for (let i = 1; i <= tenantCount; i += 1) {
  const result = await seedTenant(i);
  results.push(result);
  console.error(`  seeded ${result.tenantSlug} (tenant ${result.tenantId})`);
}
await client.end();

const fixtures = results.map((r) => ({
  tenantSlug: r.tenantSlug,
  parent: {
    // No Supabase account exists yet for this member — see the "Parent
    // accounts" step printed below + tests/performance/README.md.
    // `password: null` makes a scenario fail LOUDLY (not silently) if it
    // tries to log this parent in before the manual step is done.
    email: `admin+${r.tenantSlug}@familyhub.test`,
    password: null,
    adminMemberId: r.adminMemberId,
  },
  kids: r.kidMemberIds.map((memberId, i) => ({
    memberId,
    pin: KID_PIN,
    displayName: r.kidNames[i],
  })),
}));

mkdirSync(dirname(fixturesOutPath), { recursive: true });
writeFileSync(fixturesOutPath, JSON.stringify(fixtures, null, 2) + '\n');

console.error(`\nWrote ${fixtures.length} tenant fixture(s) to ${fixturesOutPath}`);
console.error(`\nKid sessions are ready to run right now:`);
console.error(`  k6 run -e LOAD_FIXTURES=${fixturesOutPath} tests/performance/scenarios/smoke.js`);
console.error(`\nParent accounts (manual step — only needed for parentSession load testing):`);
console.error(`  This script CANNOT create Supabase Auth users — no Supabase Admin API`);
console.error(`  credentials here, by design (FHS-460). For each tenant above:`);
console.error(`    1. Create a Supabase user (dashboard or Admin API) with the email from`);
console.error(`       fixtures[].parent.email, in the SAME Supabase project the target api`);
console.error(`       points at (staging).`);
console.error(`    2. Edit fixtures[].parent.password to the password you set.`);
console.error(`    3. Link that Supabase user to the seeded admin member row:`);
console.error(`         UPDATE members SET user_id = '<supabase-user-uuid>'`);
console.error(`           WHERE id = '<fixtures[].parent.adminMemberId>';`);
console.error(`  Full walkthrough: tests/performance/README.md.`);
console.error(`\nPurge these tenants later with:`);
console.error(
  `  DELETE FROM tenants WHERE slug LIKE 'loadtest-${runId}-%';   -- cascades everywhere`,
);
