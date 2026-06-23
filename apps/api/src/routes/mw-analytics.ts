import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { loadCaller, canManage, memberInTenant } from '../lib/permissions.js';
import { computeMemberAnalytics } from '../lib/myworld.js';

// FHS-298 / FHS-369 — My World analytics (read-only, per child). The query lives
// in lib/myworld.ts (computeMemberAnalytics) so the parent + kid routes share it.

export const mwAnalyticsResponseSchema = z.object({
  stickersPerWeek: z.array(
    z.object({
      weekNumber: z.number().int(),
      year: z.number().int(),
      startDate: z.string(),
      totalStickers: z.number().int(),
      daysCompleted: z.number().int(),
      completionRate: z.number().int(),
    }),
  ),
  habitStats: z.array(
    z.object({
      habitId: z.string().uuid(),
      name: z.string(),
      habitIcon: z.string().nullable(),
      totalDays: z.number().int(),
      completedDays: z.number().int(),
      rate: z.number().int(),
    }),
  ),
});

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

  return c.json(
    mwAnalyticsResponseSchema.parse(await computeMemberAnalytics(db, tenantId, memberId)),
  );
});
