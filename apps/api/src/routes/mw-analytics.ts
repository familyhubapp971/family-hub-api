import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { habits, habitStickers, mwInvestments, mwWeeks } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { loadCaller, canManage, memberInTenant } from '../lib/permissions.js';

// FHS-298 — My World analytics (read-only, per child).
//
// Faithful port of the legacy analytics endpoint:
//   • stickersPerWeek — Potential Value per week (sticker value, doubled for a
//     habit that has an active investment that week) + a DISTINCT completion %
//     (sticker rows placed / (active habits × 7)).
//   • habitStats — per-habit success rate across all of the child's weeks.
// Everything is scoped to (tenant, member); same auth chain as the other reads.

const INVESTMENT_MULTIPLIER = 2;
const memberQuerySchema = z.object({ memberId: z.string().uuid() });

export const mwAnalyticsRouter = new Hono().get('/', async (c) => {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) throw new Error('mw-analytics handler reached without userRow');
  const tenantId = c.get('tenantId') as string | undefined;
  if (!tenantId) {
    return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
  }
  const parsed = memberQuerySchema.safeParse({ memberId: c.req.query('memberId') });
  if (!parsed.success) {
    return c.json({ error: 'invalid request', detail: 'memberId (uuid) required' }, 400);
  }
  const { memberId } = parsed.data;

  const db = getDb();
  const caller = await loadCaller(db, tenantId, userRow.id);
  if (!caller) return c.json({ error: 'forbidden', detail: 'caller is not a member' }, 403);
  if (!(await memberInTenant(db, tenantId, memberId))) {
    return c.json({ error: 'not found', detail: 'member not found in this tenant' }, 404);
  }
  if (!canManage(caller, memberId)) {
    return c.json({ error: 'forbidden', detail: 'not allowed for this member' }, 403);
  }

  // Active (non-archived) habits for this child — drives the completion-%
  // denominator (habits × 7 days). Like the legacy view, this uses the CURRENT
  // habit roster for every week (a single scalar), not a per-week count.
  const [habitCountRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(habits)
    .where(
      and(eq(habits.tenantId, tenantId), eq(habits.memberId, memberId), isNull(habits.archivedAt)),
    );
  const totalHabitCount = habitCountRow?.n ?? 0;
  const weeklyPossibleDays = Math.max(1, totalHabitCount * 7);

  // Potential value + days completed per week.
  const stickersPerWeekRows = await db
    .select({
      weekId: mwWeeks.id,
      weekNumber: mwWeeks.weekNumber,
      year: mwWeeks.year,
      startDate: mwWeeks.startDate,
      totalStickers: sql<number>`coalesce(sum(
        ${habitStickers.stickerValue} * CASE WHEN EXISTS (
          SELECT 1 FROM ${mwInvestments}
          WHERE ${mwInvestments.habitId} = ${habitStickers.habitId}
            AND ${mwInvestments.weekId} = ${habitStickers.weekId}
            AND ${mwInvestments.isActive} = true
            AND ${mwInvestments.tenantId} = ${tenantId}
            AND ${mwInvestments.memberId} = ${memberId}
        ) THEN ${INVESTMENT_MULTIPLIER} ELSE 1 END
      ), 0)::int`,
      daysCompleted: sql<number>`count(${habitStickers.id})::int`,
    })
    .from(habitStickers)
    .innerJoin(mwWeeks, and(eq(habitStickers.weekId, mwWeeks.id), eq(mwWeeks.tenantId, tenantId)))
    .where(and(eq(habitStickers.tenantId, tenantId), eq(habitStickers.memberId, memberId)))
    .groupBy(mwWeeks.id, mwWeeks.weekNumber, mwWeeks.year, mwWeeks.startDate)
    .orderBy(asc(mwWeeks.year), asc(mwWeeks.weekNumber));

  const stickersPerWeek = stickersPerWeekRows.map((w) => ({
    weekNumber: w.weekNumber,
    year: w.year,
    startDate: w.startDate,
    totalStickers: w.totalStickers ?? 0,
    daysCompleted: w.daysCompleted ?? 0,
    completionRate: Math.min(100, Math.round(((w.daysCompleted ?? 0) / weeklyPossibleDays) * 100)),
  }));

  // Total weeks the child has — drives each habit's success-rate denominator.
  // Counts ALL of the child's weeks (incl. zero-sticker ones), whereas
  // stickersPerWeek above only lists weeks that actually have stickers.
  const [weekCountRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mwWeeks)
    .where(and(eq(mwWeeks.tenantId, tenantId), eq(mwWeeks.memberId, memberId)));
  const totalWeeks = weekCountRow?.n || 1;
  const possibleDays = totalWeeks * 7;

  // Per-habit completed-day counts across all weeks.
  const habitStatRows = await db
    .select({
      habitId: habits.id,
      name: habits.name,
      habitIcon: habits.icon,
      completedDays: sql<number>`count(${habitStickers.id})::int`,
    })
    .from(habits)
    .leftJoin(
      habitStickers,
      and(
        eq(habitStickers.habitId, habits.id),
        eq(habitStickers.tenantId, tenantId),
        eq(habitStickers.memberId, memberId),
      ),
    )
    .where(
      and(eq(habits.tenantId, tenantId), eq(habits.memberId, memberId), isNull(habits.archivedAt)),
    )
    .groupBy(habits.id, habits.name, habits.icon);

  const habitStats = habitStatRows.map((row) => ({
    habitId: row.habitId,
    name: row.name,
    habitIcon: row.habitIcon,
    totalDays: possibleDays,
    completedDays: row.completedDays ?? 0,
    rate: possibleDays > 0 ? Math.round(((row.completedDays ?? 0) / possibleDays) * 100) : 0,
  }));

  return c.json({ stickersPerWeek, habitStats });
});
