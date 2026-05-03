import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { habits, rewards, type NewHabit, type NewReward } from './schema.js';
import type * as Schema from './schema.js';

// FHS-40 — starter content seeded once per tenant when onboarding
// completes. Called from inside the POST /api/onboarding/complete
// transaction (FHS-37) so seeded rows roll back together with the
// tenant.onboarding_completed flip if anything fails.
//
// Idempotency lives at the caller: the route returns 200 without
// running the transaction when onboarding_completed is already true,
// so this seed never fires twice per tenant.
//
// Defaults are intentionally short and culture-neutral. Customisation
// happens in-app — the family edits/deletes/extends from settings.

// --- Habits ---------------------------------------------------------
// Five starter habits across reading, tidiness, kindness, exercise,
// and veggies — covers most family-hub use cases without overwhelming
// a brand-new tenant.
export const DEFAULT_HABITS: ReadonlyArray<Omit<NewHabit, 'tenantId'>> = [
  { name: 'Read', description: '20 minutes of reading', cadence: 'daily', color: '#a855f7' },
  { name: 'Tidy room', description: 'Bed made + floor clear', cadence: 'daily', color: '#22c55e' },
  {
    name: 'Kind act',
    description: 'One small act of kindness',
    cadence: 'daily',
    color: '#f472b6',
  },
  { name: 'Exercise', description: '15 minutes of movement', cadence: 'daily', color: '#f59e0b' },
  {
    name: 'Eat veggies',
    description: 'Veggies on the plate at one meal',
    cadence: 'daily',
    color: '#84cc16',
  },
] as const;

// --- Rewards --------------------------------------------------------
// Three starter rewards at low / mid / high sticker costs so the
// economy works the moment a kid starts earning.
export const DEFAULT_REWARDS: ReadonlyArray<Omit<NewReward, 'tenantId'>> = [
  {
    name: 'Extra screen time',
    description: '15 minutes of screen time',
    stickerCost: 5,
    icon: '📺',
  },
  {
    name: 'Movie night pick',
    description: 'Pick the family movie tonight',
    stickerCost: 10,
    icon: '🎬',
  },
  {
    name: 'Weekend outing pick',
    description: 'Choose where the family goes this weekend',
    stickerCost: 20,
    icon: '🎉',
  },
] as const;

// --- Meal template --------------------------------------------------
// AC reads "empty weekly meal template" — the meal_templates table is
// created by the migration; seed inserts NOTHING. The UI fills the
// 7-day × 4-slot grid from whatever exists in the table, so an empty
// table renders as a blank planner the family can fill in.
//
// Documenting the deliberate no-op here so a future contributor
// doesn't add seed rows assuming they were forgotten.

export interface SeedTenantDefaultsCounts {
  habitsAdded: number;
  rewardsAdded: number;
  mealTemplatesAdded: number;
}

// db param accepts either the production Drizzle instance OR a
// transaction handle inside `db.transaction(async (tx) => …)`. The
// transaction callback's first arg has the same `insert` signature
// as the database itself but with a different concrete generic, so
// we accept their union here. `Pick` narrows the union to the only
// method we actually use, which sidesteps the structural-mismatch
// errors you get if you accept the full database surface.
type SeedDb =
  | Pick<NodePgDatabase<typeof Schema>, 'insert'>
  | Pick<Parameters<Parameters<NodePgDatabase<typeof Schema>['transaction']>[0]>[0], 'insert'>;

/**
 * Insert the starter habits + rewards for a tenant. Returns counts
 * for the caller's log line. Empty meal-template seeding is
 * deliberately omitted (see above).
 *
 * Caller MUST guard against re-runs (the FHS-37 onboarding endpoint
 * does so via the onboarding_completed flag); this function does NOT
 * check for existing rows. Re-running would duplicate everything.
 */
export async function seedTenantDefaults(
  db: SeedDb,
  tenantId: string,
): Promise<SeedTenantDefaultsCounts> {
  const habitRows: NewHabit[] = DEFAULT_HABITS.map((h) => ({ ...h, tenantId }));
  const insertedHabits = await db.insert(habits).values(habitRows).returning({ id: habits.id });

  const rewardRows: NewReward[] = DEFAULT_REWARDS.map((r) => ({ ...r, tenantId }));
  const insertedRewards = await db.insert(rewards).values(rewardRows).returning({ id: rewards.id });

  return {
    habitsAdded: insertedHabits.length,
    rewardsAdded: insertedRewards.length,
    mealTemplatesAdded: 0,
  };
}
