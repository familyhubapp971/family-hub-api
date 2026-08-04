import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { publicFeedback } from '../db/schema.js';

// FHS-429: anonymous public feedback collection.
//
// Single route: POST /api/public/feedback
// Auth: NONE: called from the logged-out marketing homepage.
// All survey fields optional, but at least one survey field must be present
// (name/email alone do not count).

// ─── Zod schema ───────────────────────────────────────────────────────────────

const SURVEY_FIELDS = [
  'pmfDisappointment',
  'recommendScore',
  'solvesProblem',
  'easeOfUse',
  'keepUsing',
  'painPoint',
  'featureRequest',
  'otherFeedback',
] as const;

export const publicFeedbackRequestSchema = z
  .object({
    name: z.string().max(120).optional(),
    email: z.string().email().max(200).optional(),
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
      SURVEY_FIELDS.some((f) => {
        const v = d[f];
        if (v === undefined) return false;
        // Non-empty string for text fields; any number for numeric fields.
        if (typeof v === 'string') return v.length > 0;
        return true;
      }),
    { message: 'at least one survey field must be present' },
  );

export const publicFeedbackResponseSchema = z.object({
  success: z.literal(true),
  id: z.string().uuid(),
});

// ─── Router ───────────────────────────────────────────────────────────────────

export const publicFeedbackRouter = new Hono()

  // POST /api/public/feedback: submit an anonymous survey response.
  // No auth, no tenant context, no pinRequestTenant.
  .post('/', async (c) => {
    const rawBody = (await c.req.json().catch(() => null)) as unknown;
    const parsed = publicFeedbackRequestSchema.safeParse(rawBody);
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
      name,
      email,
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
      .insert(publicFeedback)
      .values({
        name: name ?? null,
        email: email ?? null,
        pmfDisappointment: pmfDisappointment ?? null,
        recommendScore: recommendScore ?? null,
        solvesProblem: solvesProblem ?? null,
        easeOfUse: easeOfUse ?? null,
        keepUsing: keepUsing ?? null,
        painPoint: painPoint ?? null,
        featureRequest: featureRequest ?? null,
        otherFeedback: otherFeedback ?? null,
        source: 'public',
      })
      .returning({ id: publicFeedback.id });

    if (!row) {
      return c.json({ error: 'insert failed', errorCode: 'PUBLIC_FEEDBACK_INSERT_NO_ROW' }, 500);
    }

    return c.json(publicFeedbackResponseSchema.parse({ success: true, id: row.id }), 201);
  });
