import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, type Database } from '../db/client.js';
import { learnProgress } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { loadCaller, canManage, memberInTenant } from '../lib/permissions.js';
import {
  getQuestions,
  gradeAnswer,
  isLessonSubject,
  CERTIFICATE_TARGET,
  type Difficulty,
} from '../lib/learn-questions.js';

// FHS-270 — GET /api/learn, PATCH /api/learn/:subject.
//
// Backs the ChildWorld Learn cards: a fixed set of subjects each with a
// 0–100 progress bar. The actual learning content is a separate epic;
// this just persists progress so the cards aren't empty. Parent-accessed
// (standard auth); memberId is passed + validated.

// The fixed subject catalogue (matches the Learn card UI).
// 'Reading' is now the Reading Log feature, not a subject card.
// 'Creative' dropped — may return in a later epic.
export const LEARN_SUBJECTS = ['Maths', 'World Flags', 'Logic', 'Science'] as const;

export const learnSubjectSchema = z.object({
  subject: z.string(),
  progress: z.number().int().min(0).max(100),
});

export const listLearnResponseSchema = z.object({
  subjects: z.array(learnSubjectSchema),
});

// FHS-283 — interactive lesson schemas.
const difficultySchema = z.enum(['easy', 'medium', 'hard']);

export const lessonStatsSchema = z.object({
  progress: z.number().int().min(0).max(100),
  score: z.number().int().min(0),
  streak: z.number().int().min(0),
  best: z.number().int().min(0),
  answered: z.number().int().min(0),
  certificate: z.boolean(),
});
export type LessonStats = z.infer<typeof lessonStatsSchema>;

export const lessonQuestionsResponseSchema = z.object({
  subject: z.string(),
  difficulty: difficultySchema,
  questions: z.array(
    z.object({ id: z.string(), prompt: z.string(), choices: z.array(z.string()) }),
  ),
  stats: lessonStatsSchema,
});

export const answerRequestSchema = z.object({
  memberId: z.string().uuid(),
  questionId: z.string().min(1),
  choiceIndex: z.number().int().min(0),
});

export const lessonAnswerResponseSchema = z.object({
  correct: z.boolean(),
  answerIndex: z.number().int().min(0),
  stats: lessonStatsSchema,
});

interface ProgressRow {
  progress: number;
  currentStreak: number;
  bestStreak: number;
  totalCorrect: number;
  totalAnswered: number;
  certificateAt: Date | null;
}

function toStats(row: ProgressRow | undefined): LessonStats {
  return {
    progress: row?.progress ?? 0,
    score: row?.totalCorrect ?? 0,
    streak: row?.currentStreak ?? 0,
    best: row?.bestStreak ?? 0,
    answered: row?.totalAnswered ?? 0,
    certificate: !!row?.certificateAt,
  };
}

// Shared permission gate: caller is a tenant member who may manage the target
// member. Returns an error envelope (or null when allowed).
async function checkMemberAccess(
  db: Database,
  tenantId: string,
  callerUserId: string,
  memberId: string,
): Promise<{ status: 403 | 404; body: Record<string, string> } | null> {
  const caller = await loadCaller(db, tenantId, callerUserId);
  if (!caller) {
    return {
      status: 403,
      body: { error: 'forbidden', detail: 'caller is not a member of this tenant' },
    };
  }
  if (!(await memberInTenant(db, tenantId, memberId))) {
    return { status: 404, body: { error: 'not found', detail: 'member not found in this tenant' } };
  }
  if (!canManage(caller, memberId)) {
    return { status: 403, body: { error: 'forbidden', detail: 'not allowed for this member' } };
  }
  return null;
}

async function loadProgressRow(
  db: Database,
  tenantId: string,
  memberId: string,
  subject: string,
): Promise<ProgressRow | undefined> {
  const rows = await db
    .select({
      progress: learnProgress.progress,
      currentStreak: learnProgress.currentStreak,
      bestStreak: learnProgress.bestStreak,
      totalCorrect: learnProgress.totalCorrect,
      totalAnswered: learnProgress.totalAnswered,
      certificateAt: learnProgress.certificateAt,
    })
    .from(learnProgress)
    .where(
      and(
        eq(learnProgress.tenantId, tenantId),
        eq(learnProgress.memberId, memberId),
        eq(learnProgress.subject, subject),
      ),
    )
    .limit(1);
  return rows[0];
}

const memberQuerySchema = z.object({ memberId: z.string().uuid() });
const patchRequestSchema = z.object({
  memberId: z.string().uuid(),
  progress: z.number().int().min(0).max(100),
});

export const learnRouter = new Hono()
  .get('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('learn handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const parsed = memberQuerySchema.safeParse({ memberId: c.req.query('memberId') });
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const db = getDb();
    const caller = await loadCaller(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    if (!(await memberInTenant(db, tenantId, parsed.data.memberId))) {
      return c.json({ error: 'not found', detail: 'member not found in this tenant' }, 404);
    }
    if (!canManage(caller, parsed.data.memberId)) {
      return c.json({ error: 'forbidden', detail: 'not allowed for this member' }, 403);
    }
    const rows = await db
      .select({ subject: learnProgress.subject, progress: learnProgress.progress })
      .from(learnProgress)
      .where(
        and(eq(learnProgress.tenantId, tenantId), eq(learnProgress.memberId, parsed.data.memberId)),
      );
    const stored = new Map(rows.map((r) => [r.subject, r.progress]));
    // Always return the full fixed catalogue, defaulting unseen subjects
    // to 0 — the UI renders one card per subject regardless.
    const subjects = LEARN_SUBJECTS.map((subject) => ({
      subject,
      progress: stored.get(subject) ?? 0,
    }));
    return c.json(listLearnResponseSchema.parse({ subjects }));
  })
  // FHS-283 — questions for an interactive lesson + the child's current stats.
  .get('/:subject/questions', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('learn handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const subject = decodeURIComponent(c.req.param('subject'));
    if (!isLessonSubject(subject)) {
      return c.json({ error: 'unknown subject', detail: 'subject has no interactive lesson' }, 400);
    }
    const parsed = z
      .object({ memberId: z.string().uuid(), difficulty: difficultySchema.default('easy') })
      .safeParse({
        memberId: c.req.query('memberId'),
        difficulty: c.req.query('difficulty') ?? 'easy',
      });
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const db = getDb();
    const denied = await checkMemberAccess(db, tenantId, userRow.id, parsed.data.memberId);
    if (denied) return c.json(denied.body, denied.status);
    const row = await loadProgressRow(db, tenantId, parsed.data.memberId, subject);
    return c.json(
      lessonQuestionsResponseSchema.parse({
        subject,
        difficulty: parsed.data.difficulty,
        questions: getQuestions(subject, parsed.data.difficulty as Difficulty),
        stats: toStats(row),
      }),
    );
  })
  // FHS-283 — grade one answer and persist the updated streak/score/progress.
  .post('/:subject/answer', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('learn handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const subject = decodeURIComponent(c.req.param('subject'));
    if (!isLessonSubject(subject)) {
      return c.json({ error: 'unknown subject', detail: 'subject has no interactive lesson' }, 400);
    }
    const parsed = answerRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    // Permission check FIRST — grading returns the correct answer, so it must
    // never run for a caller who can't manage this member (no cross-tenant leak).
    const db = getDb();
    const denied = await checkMemberAccess(db, tenantId, userRow.id, parsed.data.memberId);
    if (denied) return c.json(denied.body, denied.status);

    const graded = gradeAnswer(subject, parsed.data.questionId, parsed.data.choiceIndex);
    if (!graded) {
      return c.json(
        { error: 'unknown question', detail: 'no such question for this subject' },
        400,
      );
    }

    const prev = await loadProgressRow(db, tenantId, parsed.data.memberId, subject);
    const totalAnswered = (prev?.totalAnswered ?? 0) + 1;
    const totalCorrect = (prev?.totalCorrect ?? 0) + (graded.correct ? 1 : 0);
    const currentStreak = graded.correct ? (prev?.currentStreak ?? 0) + 1 : 0;
    const bestStreak = Math.max(prev?.bestStreak ?? 0, currentStreak);
    const progress = Math.min(100, Math.round((totalCorrect / CERTIFICATE_TARGET) * 100));
    // Certificate is sticky once earned.
    const certificateAt = prev?.certificateAt ?? (progress >= 100 ? new Date() : null);

    await db
      .insert(learnProgress)
      .values({
        tenantId,
        memberId: parsed.data.memberId,
        subject,
        progress,
        currentStreak,
        bestStreak,
        totalCorrect,
        totalAnswered,
        certificateAt,
      })
      .onConflictDoUpdate({
        target: [learnProgress.tenantId, learnProgress.memberId, learnProgress.subject],
        set: {
          progress,
          currentStreak,
          bestStreak,
          totalCorrect,
          totalAnswered,
          certificateAt,
          updatedAt: sql`now()`,
        },
      });

    return c.json(
      lessonAnswerResponseSchema.parse({
        correct: graded.correct,
        answerIndex: graded.answerIndex,
        stats: toStats({
          progress,
          currentStreak,
          bestStreak,
          totalCorrect,
          totalAnswered,
          certificateAt,
        }),
      }),
    );
  })
  .patch('/:subject', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('learn handler reached without userRow');
    const tenantId = c.get('tenantId');
    if (!tenantId) {
      return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
    }
    const subject = decodeURIComponent(c.req.param('subject'));
    if (!(LEARN_SUBJECTS as readonly string[]).includes(subject)) {
      return c.json(
        { error: 'unknown subject', detail: 'subject not in the Learn catalogue' },
        400,
      );
    }
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = patchRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const db = getDb();
    const caller = await loadCaller(db, tenantId, userRow.id);
    if (!caller) {
      return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
    }
    if (!(await memberInTenant(db, tenantId, parsed.data.memberId))) {
      return c.json({ error: 'not found', detail: 'member not found in this tenant' }, 404);
    }
    if (!canManage(caller, parsed.data.memberId)) {
      return c.json({ error: 'forbidden', detail: 'not allowed for this member' }, 403);
    }
    await db
      .insert(learnProgress)
      .values({
        tenantId,
        memberId: parsed.data.memberId,
        subject,
        progress: parsed.data.progress,
      })
      .onConflictDoUpdate({
        target: [learnProgress.tenantId, learnProgress.memberId, learnProgress.subject],
        set: { progress: parsed.data.progress, updatedAt: sql`now()` },
      });
    return c.json({ subject, progress: parsed.data.progress });
  });
