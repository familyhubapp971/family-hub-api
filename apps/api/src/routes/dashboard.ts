import { Hono } from 'hono';
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  inArray,
  isNull,
  isNotNull,
  sql,
} from 'drizzle-orm';
import {
  dashboardTodayResponseSchema,
  type DashboardActivity,
  type DashboardGoal,
  type DashboardMember,
  type DashboardTodayResponse,
} from '@familyhub/shared';
import { getDb } from '../db/client.js';
import {
  activityLogs,
  events,
  habits,
  habitStickers,
  mealTemplates,
  members,
  mwWeeks,
  mwWeekActions,
  redemptionRequests,
  rewards,
  savings,
  savingsTransactions,
  tasks,
  tenants,
  weeks,
} from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { stickerBalances } from '../lib/myworld.js';

// FHS-228 / FHS-262: GET /api/dashboard/today.
//
// Bundles everything the home (Dashboard / Today) tab renders so the page
// makes one round-trip instead of fanning out to /api/members + /api/habits
// + /api/tasks + /api/savings + /api/activity. Caller must be a member of
// the resolved tenant. Same auth shape as /api/members.
//
// FHS-262 expanded the response with per-member habit progress, weekly
// streaks, pending-task counts and a status line, plus a Today's Snapshot
// stat row, a Family Goals sidebar and a Recent Activity feed. The response
// contract lives in @familyhub/shared.
//
// FHS-306: rewired the THREE My World widgets:
//   • habitsDone / habitsTotal  → habit_stickers + habits.member_id (per-kid)
//   • starBalance               → stickerBalance() helper (lib/myworld.ts)
//   • recentActivity            → activityLogs merged with mw_week_actions
//
// FHS-439: beta review found Recent Activity never populated. Root cause:
// `activity_logs` has no writer anywhere in the codebase (a dead table), and
// mw_week_actions only covers My World financial moves (claim/save/invest/…).
// Nothing a beta family actually does day to day: add a task, plan a meal,
// add a calendar activity, tick a habit, get a reward approved: ever wrote
// a row either source could see. Fixed by merging in tasks, meal_templates,
// events, habit_stickers, and approved redemption_requests directly.

// Format `now` as YYYY-MM-DD in the tenant's IANA timezone. Falls back
// to UTC when the tenant has no timezone set or the value is unknown
// to Intl. Without this, a family in Asia/Dubai at 02:00 local sees
// yesterday's UTC date in the dashboard header.
export function isoDateInTimezone(now: Date, timezone: string | null | undefined): string {
  const tz = timezone ?? 'UTC';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    // Unknown timezone string: fall through to UTC.
  }
  return now.toISOString().slice(0, 10);
}

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

// Full weekday name for a meal_templates.day_of_week key, used in the
// Recent Activity feed (FHS-439): e.g. "planned Biryani for Tuesday dinner".
const WEEKDAY_LABELS: Record<string, string> = {
  sun: 'Sunday',
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
};

// Which day-of-week is `now` in the tenant's timezone, as the lowercase
// 3-letter key used by the meal_templates.day_of_week enum. Used to count
// how many meals are planned for *today* specifically.
export function weekdayKeyInTimezone(now: Date, timezone: string | null | undefined): WeekdayKey {
  const tz = timezone ?? 'UTC';
  try {
    const iso = isoDateInTimezone(now, tz);
    // Parse the tenant-local calendar date back as a UTC instant so
    // getUTCDay() returns the weekday of that date, free of the host
    // machine's own offset.
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
    return WEEKDAY_KEYS[dow] ?? 'sun';
  } catch {
    return WEEKDAY_KEYS[now.getUTCDay()] ?? 'sun';
  }
}

// Derive a friendly greeting name from the caller's email. Falls back
// to 'there' so the greeting never says 'Good morning, undefined'.
export function deriveGreetingName(email: string): string {
  const local = email.split('@')[0] ?? '';
  const first = local.split(/[._-]/)[0] ?? '';
  if (!first) return 'there';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

// Weekly streak: the number of consecutive most-recent weeks (the family's
// tracking weeks, newest first) in which the member completed at least one
// habit. Completion data is stored per-week (week_actions), not per-day, so
// the streak counts weeks, not days. An in-progress current week with no
// completion yet does not break the streak: it is skipped, not counted.
//
// `weekIdsDesc` must already exclude future weeks and be ordered newest-first.
export function computeWeeklyStreak(
  weekIdsDesc: string[],
  currentWeekId: string | null,
  completedWeekIds: Set<string>,
): number {
  let streak = 0;
  let started = false;
  for (const weekId of weekIdsDesc) {
    const done = completedWeekIds.has(weekId);
    if (!started && weekId === currentWeekId && !done) continue;
    if (done) {
      streak += 1;
      started = true;
    } else {
      break;
    }
  }
  return streak;
}

// One-line member status for the Today screen. Pending tasks take
// priority; otherwise reflect habit progress; "All done" when nothing
// is outstanding.
export function deriveStatusText(opts: {
  tasksPending: number;
  habitsDone: number;
  habitsTotal: number;
}): string {
  const { tasksPending, habitsDone, habitsTotal } = opts;
  if (tasksPending > 0) {
    return `${tasksPending} task${tasksPending === 1 ? '' : 's'} left`;
  }
  if (habitsTotal === 0 || habitsDone >= habitsTotal) {
    return 'All done';
  }
  return `${habitsDone}/${habitsTotal} habits`;
}

// Map a mw_week_actions actionType to a human-readable activity string.
function mwActionLabel(
  actionType: string,
  stickersUsed: number | null,
  rewardName: string | null,
  habitName: string | null,
): string {
  switch (actionType) {
    case 'claim':
      return `claimed ${rewardName ?? 'a reward'}`;
    case 'cashout':
      return `cashed out ${stickersUsed ?? 0}⭐`;
    case 'save':
      return `saved ${stickersUsed ?? 0}⭐`;
    case 'invest':
      return `invested ${stickersUsed ?? 0}⭐ in ${habitName ?? 'a habit'}`;
    case 'withdraw':
      return `withdrew from ${habitName ?? 'a habit'}`;
    case 'auto_save':
      return `auto-saved ${stickersUsed ?? 0}⭐`;
    case 'invest_continue':
      return `carried over ${habitName ?? 'a habit'}`;
    default:
      return actionType;
  }
}

export const dashboardRouter = new Hono().get('/today', async (c) => {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) {
    throw new Error('dashboard handler reached without userRow on context');
  }
  const tenantId = c.get('tenantId');
  if (!tenantId) {
    return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
  }

  const db = getDb();

  // 1: caller must be a member of this tenant.
  const callerRows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.userId, userRow.id)))
    .limit(1);
  if (callerRows.length === 0) {
    return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
  }

  // 2: family roster.
  const memberRows = await db
    .select({
      id: members.id,
      displayName: members.displayName,
      role: members.role,
      avatarEmoji: members.avatarEmoji,
      // FHS-273: null user_id = seat created but signup not completed.
      userId: members.userId,
    })
    .from(members)
    .where(eq(members.tenantId, tenantId))
    .orderBy(asc(members.createdAt));

  // Display-name lookup, used throughout (member cards + the Recent
  // Activity feed's actor field, FHS-439).
  const memberNameById = new Map(memberRows.map((m) => [m.id, m.displayName]));

  // 3: active habits count (family-level snapshot total, used by counts.habits
  // and by the Today's Snapshot). Per-kid habitsTotal is computed separately
  // in step 8 using habits.member_id.
  const habitRows = await db
    .select({ id: habits.id })
    .from(habits)
    .where(and(eq(habits.tenantId, tenantId), isNull(habits.archivedAt)));
  const habitsTotal = habitRows.length;

  // 4: rewards count.
  const [rewardsCountRow] = await db
    .select({ n: count() })
    .from(rewards)
    .where(and(eq(rewards.tenantId, tenantId), isNull(rewards.archivedAt)));

  // 5: tenant timezone (anchors "today").
  const [tenantRow] = await db
    .select({ timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const now = new Date();
  const today = isoDateInTimezone(now, tenantRow?.timezone);

  // 6: tracking weeks (newest first) for streak computation (legacy weeks table
  // still drives the streak calendar: the streak logic references family week
  // boundaries, not per-kid mw_weeks).
  const weekRows = await db
    .select({ id: weeks.id, startDate: weeks.startDate, endDate: weeks.endDate })
    .from(weeks)
    .where(eq(weeks.tenantId, tenantId))
    .orderBy(desc(weeks.startDate));
  const currentWeek = weekRows.find((w) => w.startDate <= today && w.endDate >= today);
  // Only weeks that have already started can contribute to a streak.
  const startedWeekIdsDesc = weekRows.filter((w) => w.startDate <= today).map((w) => w.id);

  // 7: tasks (pending per member + done-today family count + the
  // latest pending title for the adult card's status box, FHS-273).
  // `id` is also used to derive Recent Activity "added"/"completed" entries
  // (FHS-439): re-uses this same query rather than a separate round-trip.
  const taskRows = await db
    .select({
      id: tasks.id,
      memberId: tasks.memberId,
      doneAt: tasks.doneAt,
      title: tasks.title,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(eq(tasks.tenantId, tenantId))
    .orderBy(desc(tasks.createdAt));

  // 8: savings goals.
  const savingsRows = await db
    .select({ id: savings.id, name: savings.name, targetAmount: savings.targetAmount })
    .from(savings)
    .where(and(eq(savings.tenantId, tenantId), isNull(savings.archivedAt)))
    .orderBy(asc(savings.createdAt));

  // 9: goal transactions (deposits minus withdrawals = progress).
  const txRows = await db
    .select({
      savingsId: savingsTransactions.savingsId,
      amount: savingsTransactions.amount,
      type: savingsTransactions.type,
    })
    .from(savingsTransactions)
    .where(eq(savingsTransactions.tenantId, tenantId));

  // 10: Recent Activity feed sources, in ONE round-trip (FHS-463).
  //
  // The card merges six append-only sources (legacy activity_logs, My World
  // week actions, and (FHS-439) meals / calendar events / habit stickers /
  // approved reward requests). Each was previously its own SELECT ... ORDER BY
  // <ts> DESC LIMIT 5 round-trip; on the request-pinned single pg connection
  // those ran strictly serially. They're combined here into one UNION ALL so
  // the feed costs one round-trip instead of six.
  //
  // Correctness contract: this does NOT change the feed's values or ordering.
  // Each member keeps its exact WHERE / ORDER BY / LIMIT 5, so the candidate
  // set is identical to the six separate queries. The rows are split back into
  // the same per-source arrays below and handed to the UNCHANGED JS merge
  // (map → sort newest-first → slice top 5), which owns all string-building
  // and tie-breaking. A discriminator column (`src`) and per-source LIMIT keep
  // the union faithful; no outer ORDER BY / LIMIT is applied, so the JS merge
  // still sees every candidate exactly as before.
  //
  // Column layout is fixed by the FIRST member (positional union); every other
  // member SELECTs the same 15 columns in order, NULL-cast where N/A.
  const activityFeed = await db.execute(sql`
    (
      SELECT
        'log'::text AS "src",
        ${activityLogs.id}::text AS "id",
        NULL::uuid AS "memberId",
        ${members.displayName} AS "actor",
        ${activityLogs.action} AS "action",
        NULL::text AS "actionType",
        NULL::integer AS "stickersUsed",
        NULL::text AS "rewardName",
        NULL::text AS "habitName",
        NULL::text AS "name",
        NULL::text AS "slot",
        NULL::text AS "dayOfWeek",
        NULL::text AS "title",
        ${activityLogs.createdAt} AS "createdAt",
        NULL::timestamptz AS "decidedAt"
      FROM ${activityLogs}
      LEFT JOIN ${members}
        ON ${activityLogs.actorMemberId} = ${members.id}
        AND ${members.tenantId} = ${tenantId}
      WHERE ${activityLogs.tenantId} = ${tenantId}
      ORDER BY ${activityLogs.createdAt} DESC
      LIMIT 5
    )
    UNION ALL
    (
      SELECT
        'mw'::text,
        ${mwWeekActions.id}::text,
        ${mwWeekActions.memberId},
        NULL::text,
        NULL::text,
        ${mwWeekActions.actionType}::text,
        ${mwWeekActions.stickersUsed},
        ${mwWeekActions.rewardName},
        ${mwWeekActions.habitName},
        NULL::text,
        NULL::text,
        NULL::text,
        NULL::text,
        ${mwWeekActions.createdAt},
        NULL::timestamptz
      FROM ${mwWeekActions}
      WHERE ${mwWeekActions.tenantId} = ${tenantId}
      ORDER BY ${mwWeekActions.createdAt} DESC
      LIMIT 5
    )
    UNION ALL
    (
      SELECT
        'meal'::text,
        ${mealTemplates.id}::text,
        ${mealTemplates.memberId},
        NULL::text,
        NULL::text,
        NULL::text,
        NULL::integer,
        NULL::text,
        NULL::text,
        ${mealTemplates.name},
        ${mealTemplates.slot}::text,
        ${mealTemplates.dayOfWeek}::text,
        NULL::text,
        ${mealTemplates.createdAt},
        NULL::timestamptz
      FROM ${mealTemplates}
      WHERE ${mealTemplates.tenantId} = ${tenantId}
        AND ${mealTemplates.name} IS NOT NULL
      ORDER BY ${mealTemplates.createdAt} DESC
      LIMIT 5
    )
    UNION ALL
    (
      SELECT
        'event'::text,
        ${events.id}::text,
        ${events.memberId},
        NULL::text,
        NULL::text,
        NULL::text,
        NULL::integer,
        NULL::text,
        NULL::text,
        NULL::text,
        NULL::text,
        NULL::text,
        ${events.title},
        ${events.createdAt},
        NULL::timestamptz
      FROM ${events}
      WHERE ${events.tenantId} = ${tenantId}
      ORDER BY ${events.createdAt} DESC
      LIMIT 5
    )
    UNION ALL
    (
      SELECT
        'sticker'::text,
        ${habitStickers.id}::text,
        ${habitStickers.memberId},
        NULL::text,
        NULL::text,
        NULL::text,
        NULL::integer,
        NULL::text,
        ${habits.name},
        NULL::text,
        NULL::text,
        NULL::text,
        NULL::text,
        ${habitStickers.createdAt},
        NULL::timestamptz
      FROM ${habitStickers}
      LEFT JOIN ${habits} ON ${habitStickers.habitId} = ${habits.id}
      WHERE ${habitStickers.tenantId} = ${tenantId}
      ORDER BY ${habitStickers.createdAt} DESC
      LIMIT 5
    )
    UNION ALL
    (
      SELECT
        'redemption'::text,
        ${redemptionRequests.id}::text,
        ${redemptionRequests.memberId},
        NULL::text,
        NULL::text,
        NULL::text,
        NULL::integer,
        ${rewards.name},
        NULL::text,
        NULL::text,
        NULL::text,
        NULL::text,
        NULL::text,
        ${redemptionRequests.createdAt},
        ${redemptionRequests.decidedAt}
      FROM ${redemptionRequests}
      LEFT JOIN ${rewards} ON ${redemptionRequests.rewardId} = ${rewards.id}
      WHERE ${redemptionRequests.tenantId} = ${tenantId}
        AND ${redemptionRequests.status} = 'approved'
      ORDER BY ${redemptionRequests.decidedAt} DESC
      LIMIT 5
    )
  `);

  // Split the union back into the same per-source row shapes the JS merge
  // below already consumes. Postgres returns text/uuid as string, integer as
  // number, timestamptz as Date: exactly what the merge expects. Order is
  // irrelevant here: the merge re-sorts every candidate.
  type ActivityFeedRow = {
    src: string;
    id: string;
    memberId: string | null;
    actor: string | null;
    action: string | null;
    actionType: string | null;
    stickersUsed: number | null;
    rewardName: string | null;
    habitName: string | null;
    name: string | null;
    slot: string | null;
    dayOfWeek: string | null;
    title: string | null;
    // db.execute returns raw pg rows: timestamptz comes back as an ISO STRING,
    // not a Date (unlike the drizzle query builder). Coerced to Date below so
    // the downstream JS merge (which calls .getTime()) behaves exactly as it
    // did when these were six drizzle .select() queries.
    createdAt: Date | string;
    decidedAt: Date | string | null;
  };
  const feedRows = (activityFeed.rows as ActivityFeedRow[]).map((r) => ({
    ...r,
    createdAt: new Date(r.createdAt),
    decidedAt: r.decidedAt === null ? null : new Date(r.decidedAt),
  }));

  const activityRows = feedRows
    .filter((r) => r.src === 'log')
    .map((r) => ({ id: r.id, action: r.action as string, createdAt: r.createdAt, actor: r.actor }));
  const mwActionRows = feedRows
    .filter((r) => r.src === 'mw')
    .map((r) => ({
      id: r.id,
      memberId: r.memberId as string,
      actionType: r.actionType as string,
      stickersUsed: r.stickersUsed,
      rewardName: r.rewardName,
      habitName: r.habitName,
      createdAt: r.createdAt,
    }));
  const recentMealRows = feedRows
    .filter((r) => r.src === 'meal')
    .map((r) => ({
      id: r.id,
      name: r.name as string,
      slot: r.slot as string,
      dayOfWeek: r.dayOfWeek as string,
      memberId: r.memberId,
      createdAt: r.createdAt,
    }));
  const recentEventRows = feedRows
    .filter((r) => r.src === 'event')
    .map((r) => ({
      id: r.id,
      title: r.title as string,
      memberId: r.memberId,
      createdAt: r.createdAt,
    }));
  const recentStickerRows = feedRows
    .filter((r) => r.src === 'sticker')
    .map((r) => ({
      id: r.id,
      memberId: r.memberId as string,
      habitName: r.habitName,
      createdAt: r.createdAt,
    }));
  const recentApprovedRedemptionRows = feedRows
    .filter((r) => r.src === 'redemption')
    .map((r) => ({
      id: r.id,
      memberId: r.memberId as string,
      rewardName: r.rewardName,
      decidedAt: r.decidedAt,
      createdAt: r.createdAt,
    }));

  // 12: main meals (breakfast/lunch/dinner) planned for today. DISTINCT
  // slots, not rows: FHS-264 lets a slot hold a whole-family meal plus
  // per-member meals. Snacks are excluded so the Today's Snapshot reads
  // "X/3" against the three main meals (FHS-263 exact-match).
  const [mealsCountRow] = await db
    .select({ n: countDistinct(mealTemplates.slot) })
    .from(mealTemplates)
    .where(
      and(
        eq(mealTemplates.tenantId, tenantId),
        eq(mealTemplates.dayOfWeek, weekdayKeyInTimezone(now, tenantRow?.timezone)),
        isNotNull(mealTemplates.name),
        inArray(mealTemplates.slot, ['breakfast', 'lunch', 'dinner']),
      ),
    );

  // --- FHS-306: My World per-kid stats ---

  // Identify child/teen members (kids only have habits and stickers).
  const kidMemberIds = memberRows
    .filter((m) => m.role === 'child' || m.role === 'teen')
    .map((m) => m.id);

  // 13: per-kid habitsTotal: count active habits per child via habits.member_id.
  const kidHabitsTotalMap = new Map<string, number>();
  if (kidMemberIds.length > 0) {
    const kidHabitRows = await db
      .select({ memberId: habits.memberId, n: count() })
      .from(habits)
      .where(
        and(
          eq(habits.tenantId, tenantId),
          isNull(habits.archivedAt),
          inArray(habits.memberId as typeof habits.memberId, kidMemberIds),
        ),
      )
      .groupBy(habits.memberId);
    for (const row of kidHabitRows) {
      if (row.memberId !== null) {
        kidHabitsTotalMap.set(row.memberId, Number(row.n));
      }
    }
  }

  // 14: per-kid current mw_week (earliest non-finalized).
  const kidCurrentWeekMap = new Map<string, string>(); // memberId → mw_weeks.id
  if (kidMemberIds.length > 0) {
    const kidOpenWeeks = await db
      .select({ memberId: mwWeeks.memberId, weekId: mwWeeks.id })
      .from(mwWeeks)
      .where(
        and(
          eq(mwWeeks.tenantId, tenantId),
          inArray(mwWeeks.memberId, kidMemberIds),
          eq(mwWeeks.isFinalized, false),
        ),
      )
      .orderBy(asc(mwWeeks.year), asc(mwWeeks.weekNumber));
    // We want the EARLIEST open week per kid: collect first-seen per memberId.
    for (const row of kidOpenWeeks) {
      if (!kidCurrentWeekMap.has(row.memberId)) {
        kidCurrentWeekMap.set(row.memberId, row.weekId);
      }
    }
  }

  // 15: per-kid habitsDone: distinct habit_ids with a sticker in their current week.
  const kidHabitsDoneMap = new Map<string, number>(); // memberId → count
  if (kidCurrentWeekMap.size > 0) {
    const currentWeekIds = Array.from(new Set(kidCurrentWeekMap.values()));
    const stickerRows = await db
      .select({
        memberId: habitStickers.memberId,
        weekId: habitStickers.weekId,
        n: countDistinct(habitStickers.habitId),
      })
      .from(habitStickers)
      .where(
        and(eq(habitStickers.tenantId, tenantId), inArray(habitStickers.weekId, currentWeekIds)),
      )
      .groupBy(habitStickers.memberId, habitStickers.weekId);
    for (const row of stickerRows) {
      // Only count the stickers that belong to THIS kid's current week.
      const kidWeekId = kidCurrentWeekMap.get(row.memberId);
      if (kidWeekId === row.weekId) {
        kidHabitsDoneMap.set(row.memberId, Number(row.n));
      }
    }
  }

  // 16: per-kid star balance (unallocated stickers + saved stickers +
  // cash-as-stickers). FHS-463: batched into a fixed two queries via
  // stickerBalances() instead of the old 2×(kids) serial fan-out; the
  // per-kid value is identical to the previous stickerBalance() call.
  const starBalanceByMember =
    kidMemberIds.length > 0
      ? await stickerBalances(db, tenantId, kidMemberIds)
      : new Map<string, number>();

  // --- Derive task stats ---

  const tasksPendingByMember = new Map<string, number>();
  // Rows are createdAt-DESC, so the FIRST pending row seen per member is
  // their newest open task (the adult card's status line, per the mock).
  const latestPendingTaskByMember = new Map<string, string>();
  let tasksDoneToday = 0;
  for (const t of taskRows) {
    if (t.doneAt === null) {
      // tasks.member_id is NOT NULL; cross-tenant scope is guaranteed by
      // the tenantId filter on the query above.
      tasksPendingByMember.set(t.memberId, (tasksPendingByMember.get(t.memberId) ?? 0) + 1);
      if (!latestPendingTaskByMember.has(t.memberId)) {
        latestPendingTaskByMember.set(t.memberId, t.title);
      }
    } else if (isoDateInTimezone(t.doneAt, tenantRow?.timezone) === today) {
      tasksDoneToday += 1;
    }
  }
  // FHS-263: "Tasks Done X/Y" denominator: tasks done today plus all
  // still-open tasks (the actionable set today).
  let tasksOpen = 0;
  for (const n of tasksPendingByMember.values()) tasksOpen += n;
  const tasksTotalToday = tasksDoneToday + tasksOpen;

  // --- Build member response objects ---

  // For streak computation, a kid's "completed week" is any legacy week
  // where they had a habit_stickers row. Since the streak calendar uses
  // the legacy `weeks` table, we derive completedWeeksByMember from
  // habitStickers joined to mw_weeks.startDate vs weeks.startDate: but
  // this would be complex cross-table. The streak stays on the legacy
  // weekActions-derived path for now; kids with no weekActions will simply
  // have streak=0. (Streak refresh from My World is a separate ticket.)
  // completedWeeksByMember stays an empty Map: all kids start at streak=0
  // until a dedicated streak-from-stickers query is added.
  const completedWeeksByMember = new Map<string, Set<string>>();

  const responseMembers: DashboardMember[] = memberRows.map((m) => {
    const isKid = m.role === 'child' || m.role === 'teen';
    // FHS-306: kids: use My World sources; adults: habit stats not applicable.
    const habitsDone = isKid ? (kidHabitsDoneMap.get(m.id) ?? 0) : 0;
    const memberHabitsTotal = isKid ? (kidHabitsTotalMap.get(m.id) ?? 0) : 0;
    const streak = computeWeeklyStreak(
      startedWeekIdsDesc,
      currentWeek?.id ?? null,
      completedWeeksByMember.get(m.id) ?? new Set(),
    );
    const tasksPending = tasksPendingByMember.get(m.id) ?? 0;
    // FHS-273: parents don't have habits, they have tasks: their status
    // line is the newest open task's title (or 'All done'). Kids keep the
    // habit-aware derivation.
    // Kids log in by PIN, never email signup: pending only applies to
    // grown-up seats (incl. guests) without a linked login.
    const pendingSignup = !isKid && m.userId === null;
    const statusText = isKid
      ? deriveStatusText({ tasksPending, habitsDone, habitsTotal: memberHabitsTotal })
      : pendingSignup && tasksPending === 0
        ? 'Awaiting signup'
        : (latestPendingTaskByMember.get(m.id) ?? 'All done');
    return {
      id: m.id,
      displayName: m.displayName,
      role: m.role,
      avatarEmoji: m.avatarEmoji,
      habitsDone,
      // FHS-306: per-kid habitsTotal from habits.member_id; 0 for adults.
      habitsTotal: memberHabitsTotal,
      streak,
      tasksPending,
      statusText,
      // FHS-306: star balance from stickerBalance(); 0 for non-kids.
      starBalance: starBalanceByMember.get(m.id) ?? 0,
      pendingSignup,
    };
  });

  const progressByGoal = new Map<string, number>();
  for (const tx of txRows) {
    const amount = Number(tx.amount);
    const signed = tx.type === 'withdrawal' ? -amount : amount;
    progressByGoal.set(tx.savingsId, (progressByGoal.get(tx.savingsId) ?? 0) + signed);
  }
  const goals: DashboardGoal[] = savingsRows.map((s) => ({
    id: s.id,
    label: s.name,
    progress: progressByGoal.get(s.id) ?? 0,
    target: s.targetAmount === null ? null : Number(s.targetAmount),
  }));

  // FHS-306 Fix 3 / FHS-439: merge every source that can produce a Recent
  // Activity entry, sort newest-first, take the top 5. activityLogs and
  // mw_week_actions rarely fire day-to-day (see the FHS-439 note at the top
  // of this file); tasks/meals/events/stickers/redemptions are what a real
  // family actually does, so those are what makes the card populate.
  type RawActivity = { id: string; actor: string | null; action: string; createdAt: Date };

  const legacyActivities: RawActivity[] = activityRows.map((a) => ({
    id: a.id,
    actor: a.actor ?? null,
    action: a.action,
    createdAt: a.createdAt,
  }));
  const mwActivities: RawActivity[] = mwActionRows.map((a) => ({
    id: a.id,
    actor: memberNameById.get(a.memberId) ?? null,
    action: mwActionLabel(a.actionType, a.stickersUsed, a.rewardName, a.habitName),
    createdAt: a.createdAt,
  }));

  // Tasks: one row can produce an "added" moment and, separately, a
  // "completed" moment: same task id, so each gets a `:created` /
  // `:completed` suffix to stay unique (dashboardActivitySchema's `id` is a
  // plain string, not a uuid, for exactly this reason).
  const taskAddedActivities: RawActivity[] = taskRows.map((t) => ({
    id: `${t.id}:created`,
    actor: memberNameById.get(t.memberId) ?? null,
    action: `added a task: "${t.title}"`,
    createdAt: t.createdAt,
  }));
  const taskCompletedActivities: RawActivity[] = taskRows
    .filter((t): t is typeof t & { doneAt: Date } => t.doneAt !== null)
    .map((t) => ({
      id: `${t.id}:completed`,
      actor: memberNameById.get(t.memberId) ?? null,
      action: `completed a task: "${t.title}"`,
      createdAt: t.doneAt,
    }));

  const mealActivities: RawActivity[] = recentMealRows.map((m) => ({
    id: m.id,
    actor: m.memberId ? (memberNameById.get(m.memberId) ?? null) : null,
    action: `planned "${m.name}" for ${WEEKDAY_LABELS[m.dayOfWeek] ?? m.dayOfWeek} ${m.slot}`,
    createdAt: m.createdAt,
  }));

  const eventActivities: RawActivity[] = recentEventRows.map((e) => ({
    id: e.id,
    actor: e.memberId ? (memberNameById.get(e.memberId) ?? null) : null,
    action: `added "${e.title}" to the calendar`,
    createdAt: e.createdAt,
  }));

  const stickerActivities: RawActivity[] = recentStickerRows.map((s) => ({
    id: s.id,
    actor: memberNameById.get(s.memberId) ?? null,
    action: `earned a sticker for "${s.habitName ?? 'a habit'}"`,
    createdAt: s.createdAt,
  }));

  const redemptionActivities: RawActivity[] = recentApprovedRedemptionRows.map((r) => ({
    id: r.id,
    actor: memberNameById.get(r.memberId) ?? null,
    action: `got the "${r.rewardName ?? 'a reward'}" reward approved`,
    createdAt: r.decidedAt ?? r.createdAt,
  }));

  const mergedActivity = [
    ...legacyActivities,
    ...mwActivities,
    ...taskAddedActivities,
    ...taskCompletedActivities,
    ...mealActivities,
    ...eventActivities,
    ...stickerActivities,
    ...redemptionActivities,
  ]
    .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())
    .slice(0, 5);

  const recentActivity: DashboardActivity[] = mergedActivity.map((a) => ({
    id: a.id,
    actor: a.actor,
    action: a.action,
    timestamp: a.createdAt.toISOString(),
  }));

  const response: DashboardTodayResponse = {
    date: today,
    greetingName: deriveGreetingName(userRow.email),
    callerMemberId: callerRows[0]!.id,
    members: responseMembers,
    counts: {
      members: memberRows.length,
      habits: habitsTotal,
      rewards: Number(rewardsCountRow?.n ?? 0),
      tasksDoneToday,
      tasksTotalToday,
      mealsPlanned: Number(mealsCountRow?.n ?? 0),
    },
    goals,
    recentActivity,
  };

  return c.json(dashboardTodayResponseSchema.parse(response));
});
