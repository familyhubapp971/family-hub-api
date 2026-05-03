import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { habits, members, rewards, tenants } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';

// FHS-228 — GET /api/dashboard/today.
//
// Bundles everything the home (Dashboard) tab renders so the page makes
// one round-trip instead of fanning out to /api/members + /api/habits +
// /api/rewards on first paint. Caller must be a member of the resolved
// tenant. Same auth shape as /api/members.

export const dashboardMemberSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  role: z.string(),
  avatarEmoji: z.string().nullable(),
});

export const dashboardCountsSchema = z.object({
  members: z.number().int().nonnegative(),
  habits: z.number().int().nonnegative(),
  rewards: z.number().int().nonnegative(),
});

export const dashboardTodayResponseSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  greetingName: z.string(),
  members: z.array(dashboardMemberSchema),
  counts: dashboardCountsSchema,
});

export type DashboardTodayResponse = z.infer<typeof dashboardTodayResponseSchema>;

// Format `now` as YYYY-MM-DD in the tenant's IANA timezone. Falls back
// to UTC when the tenant has no timezone set or the value is unknown
// to Intl. Without this, a family in Asia/Dubai at 02:00 local sees
// yesterday's UTC date in the dashboard header.
function isoDateInTimezone(now: Date, timezone: string | null | undefined): string {
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
    // Unknown timezone string — fall through to UTC.
  }
  return now.toISOString().slice(0, 10);
}

// Derive a friendly greeting name from the caller's email. Falls back
// to 'there' so the greeting never says 'Good morning, undefined'.
function deriveGreetingName(email: string): string {
  const local = email.split('@')[0] ?? '';
  const first = local.split(/[._-]/)[0] ?? '';
  if (!first) return 'there';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
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

  const callerRows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.userId, userRow.id)))
    .limit(1);
  if (callerRows.length === 0) {
    return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
  }

  const memberRows = await db
    .select({
      id: members.id,
      displayName: members.displayName,
      role: members.role,
      avatarEmoji: members.avatarEmoji,
    })
    .from(members)
    .where(eq(members.tenantId, tenantId))
    .orderBy(asc(members.createdAt));

  // Counts must exclude soft-deleted (archived) rows or a family that
  // archives a habit will see the count keep ticking up forever.
  const [habitsCountRow] = await db
    .select({ n: count() })
    .from(habits)
    .where(and(eq(habits.tenantId, tenantId), isNull(habits.archivedAt)));

  const [rewardsCountRow] = await db
    .select({ n: count() })
    .from(rewards)
    .where(and(eq(rewards.tenantId, tenantId), isNull(rewards.archivedAt)));

  const [tenantRow] = await db
    .select({ timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const response: DashboardTodayResponse = {
    date: isoDateInTimezone(new Date(), tenantRow?.timezone),
    greetingName: deriveGreetingName(userRow.email),
    members: memberRows,
    counts: {
      members: memberRows.length,
      habits: Number(habitsCountRow?.n ?? 0),
      rewards: Number(rewardsCountRow?.n ?? 0),
    },
  };

  return c.json(dashboardTodayResponseSchema.parse(response));
});
