// FHS-384 — GET /api/learn/insights?memberId=<childMemberId>
//
// Parent/admin-only endpoint that aggregates one child's Learn activity
// across Maths, Logic, Science, and World Flags into a single insights
// payload for the parent dashboard.
//
// Auth chain (parent token — ES256 JWT, NOT a kid HS256 token):
//   1. Authenticated user (JWT via authMiddleware).
//   2. Tenant context resolved (tenantId on context).
//   3. Caller must be a member of that tenant with role admin or adult.
//      Kids/teens/guests get 403 — they call their own kid-scoped endpoints.
//   4. The target memberId must belong to the SAME tenant (else 403/404).
//   5. Caller must canManage the target member — parents can read any child
//      in their family; adults cannot read a sibling adult's data.

import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { members } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { loadCaller, isAdminOrAdult, canManage } from '../lib/permissions.js';
import { computeLearnInsights } from '../lib/learn-insights.js';
import { and, eq } from 'drizzle-orm';
import { createLogger } from '../logger.js';

const log = createLogger('learn-insights');

// ─── Response schema (exported for registry) ──────────────────────────────────

const subjectInsightSchema = z.object({
  subject: z.enum(['Maths', 'Logic', 'Science', 'World Flags']),
  progressPct: z.number().int().min(0).max(100),
  certificatesEarned: z.number().int().min(0),
  certificatesTotal: z.number().int().min(0),
  lastActive: z.string().datetime().nullable(),
  needsHelp: z.boolean(),
});

const weakestDetailSchema = z.object({
  subject: z.enum(['Maths', 'Logic', 'Science', 'World Flags']),
  detail: z.string(),
  tip: z.string(),
});

export const learnInsightsResponseSchema = z.object({
  memberId: z.string().uuid(),
  displayName: z.string(),
  subjects: z.array(subjectInsightSchema),
  weakest: weakestDetailSchema.nullable(),
  hasActivity: z.boolean(),
});

export type LearnInsightsResponse = z.infer<typeof learnInsightsResponseSchema>;

// ─── Query param schema ───────────────────────────────────────────────────────

const querySchema = z.object({
  memberId: z.string().uuid('memberId must be a valid UUID'),
});

// ─── Router ───────────────────────────────────────────────────────────────────

export const learnInsightsRouter = new Hono().get('/', async (c) => {
  // 1 — Authenticated caller.
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) throw new Error('learn-insights handler reached without userRow');

  // 2 — Tenant context.
  const tenantId = c.get('tenantId') as string | undefined;
  if (!tenantId) {
    return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
  }

  // 3 — Parse memberId query param.
  const parsed = querySchema.safeParse({ memberId: c.req.query('memberId') });
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid request',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    );
  }
  const { memberId } = parsed.data;

  const db = getDb();

  // 4 — Caller must be an authenticated member of this tenant.
  const caller = await loadCaller(db, tenantId, userRow.id);
  if (!caller) {
    return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
  }

  // 5 — Only admin / adult may call this parent endpoint.
  if (!isAdminOrAdult(caller)) {
    return c.json(
      {
        error: 'forbidden',
        errorCode: 'ADULT_REQUIRED',
        detail: 'only admin or adult members can view learn insights',
      },
      403,
    );
  }

  // 6 — Target member must exist in the same tenant (cross-tenant → 404).
  const targetRows = await db
    .select({ id: members.id, displayName: members.displayName, role: members.role })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.id, memberId)))
    .limit(1);
  const target = targetRows[0];
  if (!target) {
    return c.json({ error: 'not found', detail: 'member not found in this tenant' }, 404);
  }

  // 7 — Learn insights are only meaningful for child members. Requesting
  //     analytics for an adult member is not supported and would leak that
  //     member's existence to the caller unnecessarily.
  if (target.role !== 'child') {
    return c.json(
      {
        error: 'forbidden',
        errorCode: 'TARGET_NOT_CHILD',
        detail: 'learn insights are only available for child members',
      },
      403,
    );
  }

  // 8 — canManage check (admin/adult can read any member in their tenant).
  if (!canManage(caller, memberId)) {
    return c.json(
      { error: 'forbidden', detail: "not allowed to view this member's insights" },
      403,
    );
  }

  log.info({ tenantId, callerId: caller.id, memberId }, 'learn insights requested');

  const result = await computeLearnInsights(db, tenantId, memberId);

  return c.json(
    learnInsightsResponseSchema.parse({
      ...result,
      displayName: target.displayName,
    }),
    200,
  );
});
