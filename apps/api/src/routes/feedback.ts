import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { betaFeedback } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';

// FHS-418 — beta feedback collection.
//
// Single route: POST /api/feedback
// Auth: Bearer Supabase token + x-tenant-slug (same as every other authed route).
// All survey fields optional, but at least one must be present.

// ─── Zod schema ───────────────────────────────────────────────────────────────

export const feedbackRequestSchema = z
  .object({
    pmfDisappointment: z.enum(['very', 'somewhat', 'not']).optional(),
    recommendScore: z.number().int().min(0).max(10).optional(),
    solvesProblem: z.number().int().min(1).max(5).optional(),
    easeOfUse: z.number().int().min(1).max(5).optional(),
    keepUsing: z.number().int().min(1).max(5).optional(),
    painPoint: z.string().max(2000).optional(),
    featureRequest: z.string().max(2000).optional(),
    otherFeedback: z.string().max(2000).optional(),
  })
  .refine(
    (d) =>
      d.pmfDisappointment !== undefined ||
      d.recommendScore !== undefined ||
      d.solvesProblem !== undefined ||
      d.easeOfUse !== undefined ||
      d.keepUsing !== undefined ||
      (d.painPoint !== undefined && d.painPoint.length > 0) ||
      (d.featureRequest !== undefined && d.featureRequest.length > 0) ||
      (d.otherFeedback !== undefined && d.otherFeedback.length > 0),
    { message: 'at least one feedback field must be present' },
  );

export const feedbackResponseSchema = z.object({
  success: z.literal(true),
  id: z.string().uuid(),
});

// ─── Router ───────────────────────────────────────────────────────────────────

export const feedbackRouter = new Hono()

  // POST /api/feedback — submit a beta survey response.
  .post('/', async (c) => {
    // getAuthenticatedUser throws only if the auth middleware wasn't mounted
    // (a wiring bug — a 500 is the right signal there). The userRow mirror may
    // legitimately be absent if the mirror sync hasn't populated yet; store a
    // null id + the auth email rather than 500'ing the submission.
    const user = getAuthenticatedUser(c);
    const userRow = c.get('userRow');

    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }

    const rawBody = (await c.req.json().catch(() => null)) as unknown;
    const parsed = feedbackRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }

    const {
      pmfDisappointment,
      recommendScore,
      solvesProblem,
      easeOfUse,
      keepUsing,
      painPoint,
      featureRequest,
      otherFeedback,
    } = parsed.data;

    const db = getDb();
    const [row] = await db
      .insert(betaFeedback)
      .values({
        tenantId,
        submittedByUserId: userRow?.id ?? null,
        submittedByEmail: userRow?.email ?? user.email ?? null,
        pmfDisappointment: pmfDisappointment ?? null,
        recommendScore: recommendScore ?? null,
        solvesProblem: solvesProblem ?? null,
        easeOfUse: easeOfUse ?? null,
        keepUsing: keepUsing ?? null,
        painPoint: painPoint ?? null,
        featureRequest: featureRequest ?? null,
        otherFeedback: otherFeedback ?? null,
      })
      .returning({ id: betaFeedback.id });

    if (!row) {
      return c.json({ error: 'insert failed', errorCode: 'FEEDBACK_INSERT_NO_ROW' }, 500);
    }

    return c.json(feedbackResponseSchema.parse({ success: true, id: row.id }), 201);
  });
