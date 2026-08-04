// FHS-382: Shared Learn schemas + helpers.
//
// Extracted from routes/learn.ts so kid.ts and registry.ts can import
// them without pulling in the (now-deleted) parent /api/learn router.
// The parent Learn routes were removed in FHS-382; Learn lives only in the
// kid experience (/api/kid/*). See ADR 0017.

import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { learnProgress } from '../db/schema.js';
import { LOGIC_SUBTOPICS, type LogicSubtopic } from './learn-questions.js';
import type { Database } from '../db/client.js';

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const difficultySchema = z.enum(['easy', 'medium', 'hard']);

// FHS-371: Logic sub-topic filter.
export const subtopicSchema = z.enum(
  LOGIC_SUBTOPICS.map((s) => s.slug) as [string, ...string[]],
) as z.ZodEnum<[LogicSubtopic, ...LogicSubtopic[]]>;

export const lessonStatsSchema = z.object({
  progress: z.number().int().min(0).max(100),
  score: z.number().int().min(0),
  streak: z.number().int().min(0),
  best: z.number().int().min(0),
  answered: z.number().int().min(0),
  certificate: z.boolean(),
});
export type LessonStats = z.infer<typeof lessonStatsSchema>;

export const listLearnResponseSchema = z.object({
  subjects: z.array(
    z.object({
      subject: z.string(),
      progress: z.number().int().min(0).max(100),
    }),
  ),
});

export const lessonQuestionsResponseSchema = z.object({
  subject: z.string(),
  difficulty: difficultySchema,
  questions: z.array(
    z.object({
      id: z.string(),
      prompt: z.string(),
      choices: z.array(z.string()),
      subtopic: subtopicSchema.optional(),
    }),
  ),
  stats: lessonStatsSchema,
});

export const lessonAnswerResponseSchema = z.object({
  correct: z.boolean(),
  answerIndex: z.number().int().min(0),
  stats: lessonStatsSchema,
});

// ─── DB helper ────────────────────────────────────────────────────────────────

interface ProgressRow {
  progress: number;
  currentStreak: number;
  bestStreak: number;
  totalCorrect: number;
  totalAnswered: number;
  certificateAt: Date | null;
}

export async function loadProgressRow(
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

export function toStats(row: ProgressRow | undefined): LessonStats {
  return {
    progress: row?.progress ?? 0,
    score: row?.totalCorrect ?? 0,
    streak: row?.currentStreak ?? 0,
    best: row?.bestStreak ?? 0,
    answered: row?.totalAnswered ?? 0,
    certificate: !!row?.certificateAt,
  };
}
