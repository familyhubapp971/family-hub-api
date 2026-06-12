import { z } from 'zod';

// FHS-262 — response contract for GET /api/dashboard/today.
//
// Bundles everything the redesigned Today screen renders in one request:
// the family roster with per-member habit progress / streak / pending
// tasks / a status line, family-wide counts, the Family Goals sidebar,
// and the Recent Activity feed. Lives in @familyhub/shared so the API
// and (from FHS-263) the web client share one source of truth.

export const dashboardMemberSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  role: z.string(),
  avatarEmoji: z.string().nullable(),
  // FHS-262 — per-member Today-screen stats.
  habitsDone: z.number().int().nonnegative(),
  habitsTotal: z.number().int().nonnegative(),
  streak: z.number().int().nonnegative(),
  tasksPending: z.number().int().nonnegative(),
  statusText: z.string(),
  // FHS-263 exact-match — a kid's earned-star balance for the Family
  // Goals "Kids' Star Balances" panel. Proxy = total habit completions
  // until a spend/redeem ledger exists. 0 for adults.
  starBalance: z.number().int().nonnegative(),
  // FHS-273 — true when the member's seat exists but no login is linked
  // yet (members.user_id IS NULL): renders the "Pending — hasn't signed
  // up" chip on the dashboard card.
  pendingSignup: z.boolean(),
});

export const dashboardCountsSchema = z.object({
  members: z.number().int().nonnegative(),
  habits: z.number().int().nonnegative(),
  rewards: z.number().int().nonnegative(),
  // FHS-262 — Today's Snapshot stat row.
  tasksDoneToday: z.number().int().nonnegative(),
  mealsPlanned: z.number().int().nonnegative(),
  // FHS-263 exact-match — denominator for the "Tasks Done X/Y" tile
  // (total tasks due/done today, family-wide).
  tasksTotalToday: z.number().int().nonnegative(),
});

// A Family Goal — backed by a savings goal. `target` is nullable for
// open-ended goals (no target amount). `progress` is deposits minus
// withdrawals across the goal's transactions.
export const dashboardGoalSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  progress: z.number(),
  target: z.number().nullable(),
});

// A Recent Activity entry — derived from the activity_logs feed.
// `actor` is the acting member's display name, or null when the row
// was logged without a member (system action / member since removed).
export const dashboardActivitySchema = z.object({
  id: z.string().uuid(),
  actor: z.string().nullable(),
  action: z.string(),
  timestamp: z.string().datetime(),
});

export const dashboardTodayResponseSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  greetingName: z.string(),
  // FHS-261 — the caller's own member id, so the web can scope
  // "my" stats (e.g. the My Tasks tab badge) without a second lookup.
  callerMemberId: z.string().uuid(),
  members: z.array(dashboardMemberSchema),
  counts: dashboardCountsSchema,
  goals: z.array(dashboardGoalSchema),
  recentActivity: z.array(dashboardActivitySchema),
});

export type DashboardMember = z.infer<typeof dashboardMemberSchema>;
export type DashboardCounts = z.infer<typeof dashboardCountsSchema>;
export type DashboardGoal = z.infer<typeof dashboardGoalSchema>;
export type DashboardActivity = z.infer<typeof dashboardActivitySchema>;
export type DashboardTodayResponse = z.infer<typeof dashboardTodayResponseSchema>;
