import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, gte, isNull, lte, min, or, sql } from 'drizzle-orm';
import { quoteIndexForDate } from '@familyhub/shared';
import { kidAuthMiddleware, requireKidAuth, getKidAuth } from '../middleware/kid-auth.js';
import { getDb, pinRequestTenant } from '../db/client.js';
import {
  events,
  habits,
  journalEntries,
  learnProgress,
  mealTemplates,
  members,
  readingLog,
} from '../db/schema.js';
import {
  CERTIFICATE_TARGET,
  getQuestions,
  gradeAnswer,
  isLessonSubject,
  LESSON_SUBJECTS,
  type Difficulty,
  type LogicSubtopic,
} from '../lib/learn-questions.js';
import {
  computeMemberAnalytics,
  createRedemptionRequest,
  getSavings,
  getTenantCurrency,
  loadHabitsForWeek,
  loadInvestmentsForMember,
  loadKidRewardsWithRequestStatus,
  loadSavingsForMember,
  loadWeekActions,
  loadWeeksForMember,
  loadWeekStats,
  mondayOf,
} from '../lib/myworld.js';
import { mwAnalyticsResponseSchema } from './mw-analytics.js';
import { listHabitsResponseSchema } from './habits.js';
import { listMealsResponseSchema } from './meals.js';
import { listEventsResponseSchema } from './events.js';
import {
  difficultySchema,
  subtopicSchema,
  listLearnResponseSchema,
  lessonQuestionsResponseSchema,
  lessonAnswerResponseSchema,
  loadProgressRow,
  toStats,
} from '../lib/learn-shared.js';
import { bookSchema, listBooksResponseSchema } from '../lib/reading-log-shared.js';
import {
  isValidCalendarDate,
  serializeEntry,
  journalDayResponseSchema,
  journalEntriesResponseSchema,
  journalEarliestResponseSchema,
} from './journal.js';
import { listTasksForMember, setTaskDoneForMember, taskItemSchema } from './tasks.js';
import {
  worldFlagsExploreBodySchema,
  worldFlagsLearnCompleteBodySchema,
  listExplored,
  addExplored,
  listLearnProgress,
  addLearnComplete,
} from '../lib/world-flags.js';
import { aiEnabled, generateMathLesson, lessonSchema } from '../lib/ai.js';

// FHS-374 — week shape that mirrors the full parent GET /mw/weeks shape.
export const kidWeeksResponseSchema = z.object({
  weeks: z.array(
    z.object({
      id: z.string().uuid(),
      weekNumber: z.number().int(),
      year: z.number().int(),
      startDate: z.string(),
      isFinalized: z.boolean(),
      carriedOverStickers: z.number().int(),
      carriedOverCash: z.number(),
      retrievedStickers: z.number().int(),
      retrievedCash: z.number(),
    }),
  ),
});

// FHS-374 — week stats shape (mirrors GET /mw/weeks/:id/stats).
export const kidWeekStatsResponseSchema = z.object({
  weekId: z.string().uuid(),
  totalStickers: z.number().int(),
  unallocatedStickers: z.number().int(),
  allocatedStickers: z.number().int(),
  cashValue: z.number(),
});

// FHS-374 — savings shape (mirrors GET /mw/financial/savings).
// FHS-387 — stickerRate added so the kid UI never hardcodes 0.5.
export const kidSavingsResponseSchema = z.object({
  savedStickers: z.number().int(),
  savedCash: z.number(),
  currency: z.string(),
  stickerRate: z.number(),
});

// FHS-374 — investments shape (mirrors GET /mw/financial/investments).
export const kidInvestmentSchema = z.object({
  id: z.string().uuid(),
  habitId: z.string().uuid(),
  habitName: z.string().nullable(),
  habitIcon: z.string().nullable(),
  investedStickers: z.number().int(),
  originalInvestedStickers: z.number().int(),
  currentValue: z.number(),
  currentValueStickers: z.number().int(),
  daysCompleted: z.number().int(),
  daysMissed: z.number().int(),
  // FHS-378 — false = missed days count but apply no penalty.
  deductible: z.boolean(),
});
export const kidInvestmentsResponseSchema = z.object({
  investments: z.array(kidInvestmentSchema),
});

// FHS-376 — kid rewards list now carries the kid's latest request status per
// reward. Shape: { rewards: [{id,name,description,stickerCost,icon,requestStatus}], stickerBalance }.
export const kidRewardItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  stickerCost: z.number().int(),
  icon: z.string().nullable(),
  requestStatus: z.enum(['none', 'pending', 'approved', 'declined']),
});
export const kidRewardsResponseSchema = z.object({
  rewards: z.array(kidRewardItemSchema),
  stickerBalance: z.number().int(),
});

// FHS-376 — the request row the kid gets back when they ask for a reward.
export const kidRedemptionRequestSchema = z.object({
  id: z.string().uuid(),
  memberId: z.string().uuid(),
  rewardId: z.string().uuid(),
  status: z.enum(['pending', 'approved', 'declined']),
  starCost: z.number().int(),
  requestedAt: z.string(),
});

// FHS-367 — kid learn answer + reading-log writes (memberId from the token).
export const kidLearnAnswerSchema = z.object({
  questionId: z.string().min(1),
  choiceIndex: z.number().int().min(0),
});
export const kidReadingCreateSchema = z.object({
  title: z.string().min(1).max(200),
  author: z.string().max(120).optional(),
});
export const kidReadingPatchSchema = z.object({ finished: z.boolean() });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const kidTasksResponseSchema = z.object({ tasks: z.array(taskItemSchema) });
const kidTaskPatchSchema = z.object({ done: z.boolean() });

export const kidTodayResponseSchema = z.object({
  habits: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      icon: z.string().nullable(),
      color: z.string(),
    }),
  ),
});

// FHS-373 — kid world-flags response shapes.
export const kidWorldFlagsExploredResponseSchema = z.object({
  explored: z.array(z.string()),
});
export const kidWorldFlagsLearnResponseSchema = z.object({
  progress: z.record(z.array(z.number().int())),
});

// FHS-389 — AI Maths lesson request + response shapes.
export const kidAiMathLessonBodySchema = z
  .object({
    operation: z.enum(['addition', 'subtraction', 'multiplication', 'division']),
    difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
    tableNumber: z.number().int().min(1).max(12).optional(),
  })
  .refine((d) => d.difficulty !== undefined || d.tableNumber !== undefined, {
    message: 'Either difficulty or tableNumber must be provided',
  });

// Note: two branches share enabled:true so we use a plain union (not
// discriminatedUnion, which requires unique discriminator values).
export const kidAiMathLessonResponseSchema = z.union([
  // Feature flag is OFF — clean disabled signal, not an error.
  z.object({ enabled: z.literal(false) }),
  // Flag is ON, lesson generated successfully.
  z.object({ enabled: z.literal(true), lesson: lessonSchema }),
  // Flag is ON, but AI call failed — UI shows friendly error.
  z.object({ enabled: z.literal(true), lesson: z.null(), error: z.string() }),
]);

// FHS-257 / FHS-355 — kid-scoped API surface.
//
// Mounted at /api/kid behind [kidAuthMiddleware, requireKidAuth] so every
// handler here can rely on a verified kid principal via getKidAuth(c). The
// parent Supabase auth middleware skips /api/kid (it's listed in that
// middleware's public prefixes), so a kid token never has to survive the ES256
// path. Every read is scoped to the kid's OWN tenant/member from the verified
// token — never a slug/header — so a kid can only ever see their own family.

export const kidMeResponseSchema = z.object({
  memberId: z.string().uuid(),
  tenantId: z.string().uuid(),
  tenantSlug: z.string().min(1),
});

// FHS-362 — the kid's own profile for the dashboard header: name, avatar, and
// banked stars/cash. DB-backed (members + savings), scoped to the kid's own
// member from the verified token.
export const kidProfileResponseSchema = z.object({
  displayName: z.string(),
  avatarEmoji: z.string().nullable(),
  savedStickers: z.number(),
  savedCash: z.number(),
  currency: z.string(),
});

export const kidRouter = new Hono()
  .use('*', kidAuthMiddleware())
  .use('*', requireKidAuth)
  .get('/me', (c) => {
    // No DB — just echoes the verified token claims, so no tenant pin here.
    const kid = getKidAuth(c);
    return c.json(kidMeResponseSchema.parse(kid));
  })
  // FHS-362 — the kid's own profile for the dashboard header (name + avatar +
  // banked stars/cash), scoped to the kid's own member from the token.
  .get('/profile', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const db = getDb();
    const [m] = await db
      .select({ displayName: members.displayName, avatarEmoji: members.avatarEmoji })
      .from(members)
      .where(and(eq(members.tenantId, kid.tenantId), eq(members.id, kid.memberId)))
      .limit(1);
    if (!m) {
      return c.json({ error: 'not found', detail: 'no such member for this kid' }, 404);
    }
    const [savings, currency] = await Promise.all([
      getSavings(db, kid.tenantId, kid.memberId),
      getTenantCurrency(db, kid.tenantId),
    ]);
    return c.json(
      kidProfileResponseSchema.parse({
        displayName: m.displayName,
        avatarEmoji: m.avatarEmoji,
        savedStickers: savings.savedStickers,
        savedCash: savings.savedCash,
        currency,
      }),
    );
  })
  // FHS-355 — the kid's OWN tasks (member-scoped from the kid token).
  .get('/tasks', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const tasks = await listTasksForMember(getDb(), kid.tenantId, kid.memberId);
    return c.json(kidTasksResponseSchema.parse({ tasks }));
  })
  // FHS-355 — tick/untick one of the kid's OWN tasks. The member+tenant guard in
  // setTaskDoneForMember means a kid can never touch another member's task.
  .patch('/tasks/:id', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'invalid id', detail: 'task id must be a UUID' }, 400);
    }
    const parsed = kidTaskPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    const ok = await setTaskDoneForMember(
      getDb(),
      kid.tenantId,
      kid.memberId,
      id,
      parsed.data.done,
    );
    if (!ok) {
      return c.json({ error: 'not found', detail: 'no such task for this kid' }, 404);
    }
    return c.json({ ok: true });
  })
  // FHS-355 — the kid's "Today": their own active habits (member-scoped). A
  // read-only at-a-glance list; full sticker interaction is a follow-up.
  .get('/today', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const rows = await getDb()
      .select({
        id: habits.id,
        name: habits.name,
        icon: habits.icon,
        color: habits.color,
      })
      .from(habits)
      .where(
        and(
          eq(habits.tenantId, kid.tenantId),
          eq(habits.memberId, kid.memberId),
          isNull(habits.archivedAt),
        ),
      )
      .orderBy(asc(habits.createdAt));
    return c.json(kidTodayResponseSchema.parse({ habits: rows }));
  })
  // FHS-374 — weeks list (full parent shape, identical to GET /mw/weeks).
  .get('/weeks', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const weeks = await loadWeeksForMember(getDb(), kid.tenantId, kid.memberId);
    return c.json(kidWeeksResponseSchema.parse({ weeks }));
  })
  // FHS-374 — week stats (identical to GET /mw/weeks/:id/stats).
  .get('/weeks/:id/stats', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const weekId = c.req.param('id');
    const stats = await loadWeekStats(getDb(), kid.tenantId, kid.memberId, weekId);
    if (!stats) {
      return c.json({ error: 'not found', detail: 'week not found for this kid' }, 404);
    }
    return c.json(kidWeekStatsResponseSchema.parse(stats));
  })
  // FHS-374 — week action log (identical to GET /mw/weeks/:id/actions).
  .get('/weeks/:id/actions', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const weekId = c.req.param('id');
    const actions = await loadWeekActions(getDb(), kid.tenantId, kid.memberId, weekId);
    if (!actions) {
      return c.json({ error: 'not found', detail: 'week not found for this kid' }, 404);
    }
    return c.json({ actions });
  })
  // FHS-374 — habits + stickers for a week (identical to GET /api/habits).
  // ?weekId=UUID to navigate to a past week; omit for the current open week.
  // A supplied weekId that isn't this kid's is a 404.
  .get('/habits', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const weekIdParam = c.req.query('weekId') ?? undefined;
    const result = await loadHabitsForWeek(getDb(), kid.tenantId, kid.memberId, weekIdParam);
    if (!result && weekIdParam) {
      return c.json({ error: 'not found', detail: 'week not found for this kid' }, 404);
    }
    return c.json(
      listHabitsResponseSchema.parse(
        result ?? (await loadHabitsForWeek(getDb(), kid.tenantId, kid.memberId)),
      ),
    );
  })
  // FHS-374 / FHS-376 — rewards + the kid's spendable balance + the kid's
  // latest request status per reward ('none'|'pending'|'approved'|'declined').
  .get('/rewards', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    return c.json(
      kidRewardsResponseSchema.parse(
        await loadKidRewardsWithRequestStatus(getDb(), kid.tenantId, kid.memberId),
      ),
    );
  })
  // FHS-376 — the kid ASKS to redeem a reward (no deduction; an admin approves).
  // Self-scoped from the kid token. Idempotent: a duplicate ask while one is
  // still pending returns the existing pending request (200) rather than a new
  // row. FHS-374 removed POST /redeem; this request endpoint replaces it.
  .post('/rewards/:id/request', async (c) => {
    const kid = getKidAuth(c);
    const rewardId = c.req.param('id');
    if (!UUID_RE.test(rewardId)) {
      return c.json({ error: 'invalid id', detail: 'reward id must be a UUID' }, 400);
    }
    await pinRequestTenant(kid.tenantId);
    const outcome = await createRedemptionRequest(getDb(), {
      tenantId: kid.tenantId,
      memberId: kid.memberId,
      rewardId,
    });
    if (!outcome.ok) {
      return c.json({ error: 'not found', detail: 'reward not found in this tenant' }, 404);
    }
    return c.json(kidRedemptionRequestSchema.parse(outcome.request), 200);
  })
  // FHS-374 — banked savings + currency (identical to GET /mw/financial/savings).
  .get('/financial/savings', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    return c.json(
      kidSavingsResponseSchema.parse(
        await loadSavingsForMember(getDb(), kid.tenantId, kid.memberId),
      ),
    );
  })
  // FHS-374 — active investments with live value (identical to GET /mw/financial/investments).
  .get('/financial/investments', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    return c.json(
      kidInvestmentsResponseSchema.parse(
        await loadInvestmentsForMember(getDb(), kid.tenantId, kid.memberId),
      ),
    );
  })
  // FHS-365 — the kid's meals: the family's meal plan scoped to the kid +
  // family-wide entries (server-side, not client-filtered). Read-only.
  .get('/meals', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const rows = await getDb()
      .select({
        id: mealTemplates.id,
        dayOfWeek: mealTemplates.dayOfWeek,
        slot: mealTemplates.slot,
        name: mealTemplates.name,
        memberId: mealTemplates.memberId,
        recurring: mealTemplates.recurring,
      })
      .from(mealTemplates)
      .where(
        and(
          eq(mealTemplates.tenantId, kid.tenantId),
          or(isNull(mealTemplates.memberId), eq(mealTemplates.memberId, kid.memberId)),
        ),
      )
      .orderBy(asc(mealTemplates.dayOfWeek), asc(mealTemplates.slot));
    const meals = rows
      .filter((r) => (r.name ?? '').trim() !== '')
      .map((r) => ({
        id: r.id,
        dayOfWeek: r.dayOfWeek,
        slot: r.slot,
        name: r.name ?? '',
        memberId: r.memberId ?? null,
        recurring: r.recurring,
      }));
    return c.json(listMealsResponseSchema.parse({ meals }));
  })
  // FHS-365 — the kid's schedule for a week (defaults to this week), scoped to
  // the kid + family-wide events. Read-only. Optional ?weekStart=YYYY-MM-DD.
  .get('/events', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const param = c.req.query('weekStart');
    if (param !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(param)) {
      return c.json({ error: 'invalid weekStart', detail: 'must be YYYY-MM-DD' }, 400);
    }
    const weekStart = param ?? mondayOf(new Date()).toISOString().slice(0, 10);
    const [y, m, d] = weekStart.split('-').map((s) => Number.parseInt(s, 10));
    const startMs = Date.UTC(y!, m! - 1, d!);
    // Reject a structurally-valid but nonsense date (e.g. 2026-99-99).
    if (new Date(startMs).toISOString().slice(0, 10) !== weekStart) {
      return c.json({ error: 'invalid weekStart', detail: 'not a real date' }, 400);
    }
    const weekEnd = new Date(startMs + 6 * 86_400_000).toISOString().slice(0, 10);
    const rows = await getDb()
      .select({
        id: events.id,
        date: events.date,
        startTime: events.startTime,
        endTime: events.endTime,
        title: events.title,
        notes: events.notes,
        memberId: events.memberId,
        type: events.type,
        location: events.location,
        wear: events.wear,
      })
      .from(events)
      .where(
        and(
          eq(events.tenantId, kid.tenantId),
          gte(events.date, weekStart),
          lte(events.date, weekEnd),
          or(isNull(events.memberId), eq(events.memberId, kid.memberId)),
        ),
      )
      .orderBy(asc(events.date), asc(events.startTime));
    return c.json(listEventsResponseSchema.parse({ weekStart, events: rows }));
  })
  // FHS-366 — the kid's journal for a day (or null) + the day's quote index.
  .get('/journal', async (c) => {
    const kid = getKidAuth(c);
    const date = c.req.query('date');
    if (!date || !isValidCalendarDate(date)) {
      return c.json({ error: 'invalid request', detail: 'date must be a real YYYY-MM-DD' }, 400);
    }
    await pinRequestTenant(kid.tenantId);
    const rows = await getDb()
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.tenantId, kid.tenantId),
          eq(journalEntries.memberId, kid.memberId),
          eq(journalEntries.entryDate, date),
        ),
      )
      .limit(1);
    return c.json(
      journalDayResponseSchema.parse({
        entry: rows[0] ? serializeEntry(rows[0]) : null,
        quoteIndex: quoteIndexForDate(date),
      }),
    );
  })
  // FHS-366 — the kid's past journal entries, newest first.
  .get('/journal/entries', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const rows = await getDb()
      .select()
      .from(journalEntries)
      .where(
        and(eq(journalEntries.tenantId, kid.tenantId), eq(journalEntries.memberId, kid.memberId)),
      )
      .orderBy(desc(journalEntries.entryDate));
    return c.json(journalEntriesResponseSchema.parse({ entries: rows.map(serializeEntry) }));
  })
  // FHS-366 — the kid's earliest entry date (back-nav lower bound).
  .get('/journal/earliest', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const rows = await getDb()
      .select({ earliest: min(journalEntries.entryDate) })
      .from(journalEntries)
      .where(
        and(eq(journalEntries.tenantId, kid.tenantId), eq(journalEntries.memberId, kid.memberId)),
      );
    return c.json(journalEarliestResponseSchema.parse({ earliestDate: rows[0]?.earliest ?? null }));
  })
  // FHS-376 — kids are VIEW-ONLY on the journal: PUT /api/kid/journal was
  // removed (kids only READ past entries). The GET reads above stay.
  // FHS-367 — the kid's lesson subjects (Maths/Science/Logic) + their progress.
  .get('/learn', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const rows = await getDb()
      .select({ subject: learnProgress.subject, progress: learnProgress.progress })
      .from(learnProgress)
      .where(
        and(eq(learnProgress.tenantId, kid.tenantId), eq(learnProgress.memberId, kid.memberId)),
      );
    const stored = new Map(rows.map((r) => [r.subject, r.progress]));
    const subjects = LESSON_SUBJECTS.map((subject) => ({
      subject,
      progress: stored.get(subject) ?? 0,
    }));
    return c.json(listLearnResponseSchema.parse({ subjects }));
  })
  // FHS-367 — questions for a kid's lesson + their current stats.
  // FHS-371 — optional ?subtopic= filters Logic questions by sub-topic.
  .get('/learn/:subject/questions', async (c) => {
    const kid = getKidAuth(c);
    const subject = decodeURIComponent(c.req.param('subject'));
    if (!isLessonSubject(subject)) {
      return c.json({ error: 'unknown subject', detail: 'subject has no interactive lesson' }, 400);
    }
    const parsedDifficulty = difficultySchema.safeParse(c.req.query('difficulty') ?? 'easy');
    if (!parsedDifficulty.success) {
      return c.json(
        { error: 'invalid request', detail: 'difficulty must be easy|medium|hard' },
        400,
      );
    }
    const rawSubtopic = c.req.query('subtopic');
    let subtopic: LogicSubtopic | undefined;
    if (rawSubtopic !== undefined) {
      const st = subtopicSchema.safeParse(rawSubtopic);
      if (!st.success) {
        return c.json(
          {
            error: 'invalid request',
            detail: 'subtopic must be patterns|odd-one-out|if-then|sorting',
          },
          400,
        );
      }
      subtopic = st.data;
    }
    await pinRequestTenant(kid.tenantId);
    const row = await loadProgressRow(getDb(), kid.tenantId, kid.memberId, subject);
    return c.json(
      lessonQuestionsResponseSchema.parse({
        subject,
        difficulty: parsedDifficulty.data,
        questions: getQuestions(subject, parsedDifficulty.data as Difficulty, subtopic),
        stats: toStats(row),
      }),
    );
  })
  // FHS-367 — grade one of the kid's answers + persist streak/score/progress.
  .post('/learn/:subject/answer', async (c) => {
    const kid = getKidAuth(c);
    const subject = decodeURIComponent(c.req.param('subject'));
    if (!isLessonSubject(subject)) {
      return c.json({ error: 'unknown subject', detail: 'subject has no interactive lesson' }, 400);
    }
    const parsed = kidLearnAnswerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: 'invalid request', detail: parsed.error.issues[0]?.message ?? 'bad body' },
        400,
      );
    }
    const graded = gradeAnswer(subject, parsed.data.questionId, parsed.data.choiceIndex);
    if (!graded) {
      return c.json(
        { error: 'unknown question', detail: 'no such question for this subject' },
        400,
      );
    }
    await pinRequestTenant(kid.tenantId);
    const db = getDb();
    const prev = await loadProgressRow(db, kid.tenantId, kid.memberId, subject);
    const totalAnswered = (prev?.totalAnswered ?? 0) + 1;
    const totalCorrect = (prev?.totalCorrect ?? 0) + (graded.correct ? 1 : 0);
    const currentStreak = graded.correct ? (prev?.currentStreak ?? 0) + 1 : 0;
    const bestStreak = Math.max(prev?.bestStreak ?? 0, currentStreak);
    const progress = Math.min(100, Math.round((totalCorrect / CERTIFICATE_TARGET) * 100));
    const certificateAt = prev?.certificateAt ?? (progress >= 100 ? new Date() : null);
    await db
      .insert(learnProgress)
      .values({
        tenantId: kid.tenantId,
        memberId: kid.memberId,
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
  // FHS-367 — the kid's reading log (their own books, newest first).
  .get('/reading-log', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    const rows = await getDb()
      .select({
        id: readingLog.id,
        title: readingLog.title,
        author: readingLog.author,
        finished: readingLog.finished,
        createdAt: readingLog.createdAt,
      })
      .from(readingLog)
      .where(and(eq(readingLog.tenantId, kid.tenantId), eq(readingLog.memberId, kid.memberId)))
      .orderBy(desc(readingLog.createdAt));
    return c.json(
      listBooksResponseSchema.parse({
        books: rows.map((r) => ({
          id: r.id,
          title: r.title,
          author: r.author ?? null,
          finished: r.finished,
          createdAt: r.createdAt.toISOString(),
        })),
      }),
    );
  })
  // FHS-367 — the kid adds a book to their reading log.
  .post('/reading-log', async (c) => {
    const kid = getKidAuth(c);
    const parsed = kidReadingCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { error: 'invalid request', detail: parsed.error.issues[0]?.message ?? 'bad body' },
        400,
      );
    }
    await pinRequestTenant(kid.tenantId);
    const [row] = await getDb()
      .insert(readingLog)
      .values({
        tenantId: kid.tenantId,
        memberId: kid.memberId,
        title: parsed.data.title,
        author: parsed.data.author ?? null,
      })
      .returning();
    if (!row) return c.json({ error: 'insert failed' }, 500);
    return c.json(
      bookSchema.parse({
        id: row.id,
        title: row.title,
        author: row.author ?? null,
        finished: row.finished,
        createdAt: row.createdAt.toISOString(),
      }),
      201,
    );
  })
  // FHS-367 — the kid marks a book finished/unfinished.
  .patch('/reading-log/:id', async (c) => {
    const kid = getKidAuth(c);
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'invalid id', detail: 'book id must be a UUID' }, 400);
    }
    const parsed = kidReadingPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid request', detail: 'finished (boolean) required' }, 400);
    }
    await pinRequestTenant(kid.tenantId);
    const [row] = await getDb()
      .update(readingLog)
      .set({ finished: parsed.data.finished, updatedAt: new Date() })
      .where(
        and(
          eq(readingLog.tenantId, kid.tenantId),
          eq(readingLog.memberId, kid.memberId),
          eq(readingLog.id, id),
        ),
      )
      .returning();
    if (!row) return c.json({ error: 'not found', detail: 'book not found for this kid' }, 404);
    return c.json(
      bookSchema.parse({
        id: row.id,
        title: row.title,
        author: row.author ?? null,
        finished: row.finished,
        createdAt: row.createdAt.toISOString(),
      }),
    );
  })
  // FHS-367 — the kid removes a book from their reading log.
  .delete('/reading-log/:id', async (c) => {
    const kid = getKidAuth(c);
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) {
      return c.json({ error: 'invalid id', detail: 'book id must be a UUID' }, 400);
    }
    await pinRequestTenant(kid.tenantId);
    await getDb()
      .delete(readingLog)
      .where(
        and(
          eq(readingLog.tenantId, kid.tenantId),
          eq(readingLog.memberId, kid.memberId),
          eq(readingLog.id, id),
        ),
      );
    return c.body(null, 204);
  })
  // FHS-369 — the kid's own My World analytics (stats celebration view).
  .get('/analytics', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    return c.json(
      mwAnalyticsResponseSchema.parse(
        await computeMemberAnalytics(getDb(), kid.tenantId, kid.memberId),
      ),
    );
  })
  // FHS-373 — the kid's explored country flags (from token, no memberId param).
  .get('/world-flags', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    return c.json(
      kidWorldFlagsExploredResponseSchema.parse({
        explored: await listExplored(getDb(), kid.tenantId, kid.memberId),
      }),
    );
  })
  // FHS-373 — the kid marks a country flag as explored (idempotent).
  // Body: { countryCode }
  // Returns: { explored: true }
  .post('/world-flags/explore', async (c) => {
    const kid = getKidAuth(c);
    const parsed = worldFlagsExploreBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    await pinRequestTenant(kid.tenantId);
    await addExplored(getDb(), kid.tenantId, kid.memberId, parsed.data.countryCode);
    return c.json({ explored: true });
  })
  // FHS-373 — the kid's world-flags learn progress per continent.
  // Returns: { progress: Record<continent, number[]> }
  .get('/world-flags/learn', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);
    return c.json(
      kidWorldFlagsLearnResponseSchema.parse({
        progress: await listLearnProgress(getDb(), kid.tenantId, kid.memberId),
      }),
    );
  })
  // FHS-373 — the kid marks a learn-path set as mastered (idempotent).
  // Body: { continent, chunkIndex }
  // Returns: { completed: true }
  .post('/world-flags/learn-complete', async (c) => {
    const kid = getKidAuth(c);
    const parsed = worldFlagsLearnCompleteBodySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    await pinRequestTenant(kid.tenantId);
    await addLearnComplete(
      getDb(),
      kid.tenantId,
      kid.memberId,
      parsed.data.continent,
      parsed.data.chunkIndex,
    );
    return c.json({ completed: true });
  })
  // FHS-389 — AI-generated Maths lesson (feature-flagged, default OFF).
  // Body: { operation, difficulty? | tableNumber? } — one of difficulty/tableNumber required.
  // Response when disabled: { enabled: false } (200, not an error).
  // Response when enabled + success: { enabled: true, lesson: <Lesson> }.
  // FHS-389 — cheap availability probe. Returns just the flag state with NO
  // Anthropic call, so the UI can decide whether to show the AI button without
  // burning a real (paid) lesson generation on every Maths-tab open.
  .get('/learn/maths/ai-lesson/status', (c) => {
    getKidAuth(c);
    return c.json({ enabled: aiEnabled() });
  })
  // Response when enabled + AI fails: { enabled: true, lesson: null, error: '...' }.
  // No child PII is ever sent to Anthropic — only the operation + settings.
  .post('/learn/maths/ai-lesson', async (c) => {
    const kid = getKidAuth(c);
    await pinRequestTenant(kid.tenantId);

    if (!aiEnabled()) {
      return c.json({ enabled: false });
    }

    const parsed = kidAiMathLessonBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid request',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }

    const lesson = await generateMathLesson({
      operation: parsed.data.operation,
      // exactOptionalPropertyTypes: omit undefined fields rather than passing them.
      ...(parsed.data.difficulty !== undefined ? { difficulty: parsed.data.difficulty } : {}),
      ...(parsed.data.tableNumber !== undefined ? { tableNumber: parsed.data.tableNumber } : {}),
    });

    if (!lesson) {
      return c.json({
        enabled: true,
        lesson: null,
        error: 'Could not generate lesson. Please try again.',
      });
    }

    return c.json({ enabled: true, lesson });
  });
