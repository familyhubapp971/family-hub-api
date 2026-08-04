// FHS-395: Server-authoritative Logic progress + certificate helpers.
//
// Mirrors maths-progress.ts exactly but for game_type × difficulty combos
// (5 game types × 3 difficulties = 15 possible certificates).
//
// CERTIFICATE_THRESHOLD = 10: once a kid answers 10 questions correctly for a
// given combo the system awards an mw_logic_certificates row (idempotent).

import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { mwLogicProgress, mwLogicCertificates } from '../db/schema.js';
import type { Database } from '../db/client.js';
import { gradeLogicAnswer, isLogicGameType, isLogicDifficulty } from './logic-questions.js';
import type { LogicGameType, LogicDifficulty } from './logic-questions.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const CERTIFICATE_THRESHOLD = 10;

// ─── Zod schemas ─────────────────────────────────────────────────────────────

export const gameTypeSchema = z.string().refine(isLogicGameType, { message: 'Invalid gameType' });

export const difficultySchema = z
  .string()
  .refine(isLogicDifficulty, { message: 'Invalid difficulty' });

export const answerBodySchema = z.object({
  gameType: gameTypeSchema,
  difficulty: difficultySchema,
  questionId: z.string().min(1, 'questionId is required'),
  answer: z.union([z.string(), z.boolean()]),
});

export type AnswerBody = z.infer<typeof answerBodySchema>;

// Zod schema for GET /api/kid/logic/questions query params
export const questionsQuerySchema = z.object({
  gameType: gameTypeSchema,
  difficulty: difficultySchema,
});

// Response shapes (used in OpenAPI registry)
export const logicQuestionPublicSchema = z.object({
  id: z.string(),
  type: z.enum(['truefalse', 'patterns', 'oddoneout', 'ifthen', 'sorting']),
});

export const logicCertificateSchema = z.object({
  id: z.string().uuid(),
  gameType: z.string(),
  difficulty: z.string(),
  totalCorrect: z.number(),
  earnedAt: z.string(),
});

export const answerResultSchema = z.object({
  correct: z.boolean(),
  correctAnswer: z.union([z.string(), z.boolean()]),
  explanation: z.string(),
  comboCorrect: z.number(),
  certificateEarned: z.boolean(),
});

// ─── DB helpers ───────────────────────────────────────────────────────────────

/** Fetch the current progress row for a kid × combo. Returns null if not started. */
export async function getProgress(
  db: Database,
  tenantId: string,
  memberId: string,
  gameType: LogicGameType,
  difficulty: LogicDifficulty,
) {
  const rows = await db
    .select()
    .from(mwLogicProgress)
    .where(
      and(
        eq(mwLogicProgress.tenantId, tenantId),
        eq(mwLogicProgress.memberId, memberId),
        eq(mwLogicProgress.gameType, gameType),
        eq(mwLogicProgress.difficulty, difficulty),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Upsert progress row, incrementing correctCount by delta (usually +1) and
 * totalAttempts by attemptsDelta (always +1: called for every answer).
 *
 * FHS-401: totalAttempts tracks every submitted answer (correct or wrong)
 * so the Insights API can compute accuracy = correctCount / totalAttempts.
 *
 * Read-then-write increment: a concurrent request for the same kid+combo
 * could increment from the same base value. This race is acceptable: the
 * certificate threshold (10) is high enough that a missed increment only
 * delays the award by one extra correct answer. Using SELECT FOR UPDATE
 * would add lock contention on a hot path for marginal gain.
 */
export async function upsertProgress(
  db: Database,
  tenantId: string,
  memberId: string,
  gameType: LogicGameType,
  difficulty: LogicDifficulty,
  delta: number,
  attemptsDelta: number = 1,
): Promise<number> {
  const existing = await getProgress(db, tenantId, memberId, gameType, difficulty);

  const newCount = (existing?.correctCount ?? 0) + delta;
  const newAttempts = (existing?.totalAttempts ?? 0) + attemptsDelta;

  await db
    .insert(mwLogicProgress)
    .values({
      tenantId,
      memberId,
      gameType,
      difficulty,
      correctCount: newCount,
      totalAttempts: newAttempts,
    })
    .onConflictDoUpdate({
      target: [
        mwLogicProgress.tenantId,
        mwLogicProgress.memberId,
        mwLogicProgress.gameType,
        mwLogicProgress.difficulty,
      ],
      set: {
        correctCount: newCount,
        totalAttempts: newAttempts,
        updatedAt: new Date(),
      },
    });

  return newCount;
}

/** Award a certificate (idempotent via onConflictDoNothing). Returns true if newly awarded. */
export async function awardCertificate(
  db: Database,
  tenantId: string,
  memberId: string,
  gameType: LogicGameType,
  difficulty: LogicDifficulty,
  totalCorrect: number,
): Promise<boolean> {
  const result = await db
    .insert(mwLogicCertificates)
    .values({ tenantId, memberId, gameType, difficulty, totalCorrect })
    .onConflictDoNothing({
      target: [
        mwLogicCertificates.tenantId,
        mwLogicCertificates.memberId,
        mwLogicCertificates.gameType,
        mwLogicCertificates.difficulty,
      ],
    })
    .returning({ id: mwLogicCertificates.id });

  return result.length > 0;
}

/** List all certificates for a kid (within their tenant via RLS). */
export async function listCertificates(db: Database, tenantId: string, memberId: string) {
  return db
    .select()
    .from(mwLogicCertificates)
    .where(
      and(eq(mwLogicCertificates.tenantId, tenantId), eq(mwLogicCertificates.memberId, memberId)),
    );
}

// ─── Grade-and-record ─────────────────────────────────────────────────────────

export interface AnswerResult {
  correct: boolean;
  correctAnswer: string | boolean;
  explanation: string;
  comboCorrect: number;
  certificateEarned: boolean;
}

/**
 * Server-authoritative answer handler.
 *
 * 1. Grades the submitted answer against the question bank.
 * 2. On correct: increments mw_logic_progress.correct_count (upsert).
 * 3. When count reaches CERTIFICATE_THRESHOLD: awards mw_logic_certificates
 *    (idempotent: second correct answer after cert never re-awards).
 * 4. Returns the full result including the correct answer and explanation.
 *
 * Throws if the questionId is not found in the bank (callers should treat as 400).
 */
export async function gradeAndRecord(
  db: Database,
  tenantId: string,
  memberId: string,
  gameType: LogicGameType,
  difficulty: LogicDifficulty,
  questionId: string,
  submittedAnswer: string | boolean,
): Promise<AnswerResult> {
  const gradeResult = gradeLogicAnswer(gameType, difficulty, questionId, submittedAnswer);
  if (!gradeResult) {
    throw new Error(`Question not found: ${questionId}`);
  }

  let comboCorrect = 0;
  let certificateEarned = false;

  if (gradeResult.correct) {
    // FHS-401: increment both correctCount (+1) and totalAttempts (+1).
    comboCorrect = await upsertProgress(db, tenantId, memberId, gameType, difficulty, 1, 1);

    if (comboCorrect >= CERTIFICATE_THRESHOLD) {
      certificateEarned = await awardCertificate(
        db,
        tenantId,
        memberId,
        gameType,
        difficulty,
        comboCorrect,
      );
    }
  } else {
    // FHS-401: wrong answer: increment totalAttempts (+1) but NOT correctCount.
    // upsertProgress with delta=0, attemptsDelta=1 achieves this.
    comboCorrect = await upsertProgress(db, tenantId, memberId, gameType, difficulty, 0, 1);
  }

  return {
    correct: gradeResult.correct,
    correctAnswer: gradeResult.correctAnswer,
    explanation: gradeResult.explanation,
    comboCorrect,
    certificateEarned,
  };
}
