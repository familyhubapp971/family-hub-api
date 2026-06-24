// FHS-394 — pure DB helpers + business logic for the kid Maths progression.
//
// No auth / middleware here. Callers scope every call to (tenantId, memberId)
// from the verified kid token. Shared between the kid endpoints and the
// placement-cascade unit tests.

import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { mwMathsProgress, mwMathsCertificates } from '../db/schema.js';
import type { Database } from '../db/client.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Number of correct answers needed to complete the Practice stage. */
export const PRACTICE_THRESHOLD = 10;

/** Prove stage: minimum correct answers to pass. */
export const PROVE_SCORE_THRESHOLD = 10;

/** Prove stage: maximum average seconds per answer to "pass" with speed. */
export const PROVE_TIME_THRESHOLD = 5;

/**
 * Placement gate: maximum seconds per answer to auto-master a table.
 * Deliberately stricter than PROVE_TIME_THRESHOLD (5s) — placement is a
 * fast-check shortcut, not a casual prove run. A kid who answers in ≤4s has
 * clearly mastered the table; 4.001s is not penalised in prove, but it does
 * not trigger the placement cascade.
 */
export const PLACEMENT_TIME_THRESHOLD_SECONDS = 4;

// ─── Zod schemas (request body validation) ────────────────────────────────────

export const operationSchema = z.enum(['addition', 'subtraction', 'multiplication', 'division']);
export type MathsOperation = z.infer<typeof operationSchema>;

/** PUT /api/kid/maths/progress body. */
export const updateProgressBodySchema = z
  .object({
    operation: operationSchema,
    tableNumber: z.number().int().min(1).max(12),
    learnCompleted: z.boolean().optional(),
    practiceCorrect: z.number().int().min(0).optional(),
    proveScore: z.number().int().min(0).optional(),
    proveAvgTime: z.number().min(0).optional(),
  })
  .refine(
    (d) =>
      d.learnCompleted !== undefined ||
      d.practiceCorrect !== undefined ||
      d.proveScore !== undefined ||
      d.proveAvgTime !== undefined,
    {
      message:
        'At least one stage field (learnCompleted, practiceCorrect, proveScore, proveAvgTime) must be provided',
    },
  );

/** POST /api/kid/maths/placement body. */
export const placementBodySchema = z.object({
  operation: operationSchema,
  results: z.array(
    z.object({
      tableNumber: z.number().int().min(1).max(12),
      correct: z.boolean(),
      timeSeconds: z.number().min(0),
    }),
  ),
});

/** POST /api/kid/maths/certificates body. */
export const certBodySchema = z.object({
  operation: operationSchema,
  // '1'..'12' or 'easy'|'medium'|'hard'
  difficulty: z
    .string()
    .refine(
      (v) =>
        [
          'easy',
          'medium',
          'hard',
          '1',
          '2',
          '3',
          '4',
          '5',
          '6',
          '7',
          '8',
          '9',
          '10',
          '11',
          '12',
        ].includes(v),
      { message: 'difficulty must be easy|medium|hard or a table number 1-12' },
    ),
  totalCorrect: z.number().int().positive().max(1000),
});

// ─── Response Zod schemas (used in registry + route return types) ──────────────

export const mathsProgressRowSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  memberId: z.string().uuid(),
  operation: operationSchema,
  tableNumber: z.number().int(),
  learnCompleted: z.boolean(),
  practiceCorrect: z.number().int(),
  proveScore: z.number().int(),
  proveAvgTime: z.number(),
  placementUnlocked: z.boolean(),
  updatedAt: z.string().nullable(),
});
export const listMathsProgressResponseSchema = z.object({
  progress: z.array(mathsProgressRowSchema),
});

export const mathsCertRowSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  memberId: z.string().uuid(),
  operation: operationSchema,
  difficulty: z.string(),
  totalCorrect: z.number().int(),
  earnedAt: z.string().nullable(),
});
export const listMathsCertsResponseSchema = z.object({
  certificates: z.array(mathsCertRowSchema),
});

// ─── DB helpers ───────────────────────────────────────────────────────────────

/** Serialise a DB progress row to the response shape. */
function serializeProgress(r: {
  id: string;
  tenantId: string;
  memberId: string;
  operation: string;
  tableNumber: number;
  learnCompleted: boolean;
  practiceCorrect: number;
  proveScore: number;
  proveAvgTime: number;
  placementUnlocked: boolean;
  updatedAt: Date | null;
}) {
  return {
    id: r.id,
    tenantId: r.tenantId,
    memberId: r.memberId,
    operation: r.operation as MathsOperation,
    tableNumber: r.tableNumber,
    learnCompleted: r.learnCompleted,
    practiceCorrect: r.practiceCorrect,
    proveScore: r.proveScore,
    proveAvgTime: r.proveAvgTime,
    placementUnlocked: r.placementUnlocked,
    updatedAt: r.updatedAt?.toISOString() ?? null,
  };
}

/** Serialise a DB cert row to the response shape. */
function serializeCert(r: {
  id: string;
  tenantId: string;
  memberId: string;
  operation: string;
  difficulty: string;
  totalCorrect: number;
  earnedAt: Date | null;
}) {
  return {
    id: r.id,
    tenantId: r.tenantId,
    memberId: r.memberId,
    operation: r.operation as MathsOperation,
    difficulty: r.difficulty,
    totalCorrect: r.totalCorrect,
    earnedAt: r.earnedAt?.toISOString() ?? null,
  };
}

/** All progress rows for this kid, all operations + tables, DB order. */
export async function listProgress(db: Database, tenantId: string, memberId: string) {
  const rows = await db
    .select()
    .from(mwMathsProgress)
    .where(and(eq(mwMathsProgress.tenantId, tenantId), eq(mwMathsProgress.memberId, memberId)));
  return rows.map(serializeProgress);
}

/**
 * Upsert one progress row, updating ONLY the fields provided in `updates`.
 * The identity key is (tenantId, memberId, operation, tableNumber).
 * Returns the upserted row.
 */
export async function upsertProgress(
  db: Database,
  tenantId: string,
  memberId: string,
  operation: MathsOperation,
  tableNumber: number,
  updates: {
    learnCompleted?: boolean;
    practiceCorrect?: number;
    proveScore?: number;
    proveAvgTime?: number;
  },
) {
  // Build the conflict-update set — only include provided fields so a PUT
  // with only { practiceCorrect } doesn't accidentally reset learnCompleted.
  const conflictSet: Record<string, unknown> = { updatedAt: sql`now()` };
  if (updates.learnCompleted !== undefined) conflictSet['learnCompleted'] = updates.learnCompleted;
  if (updates.practiceCorrect !== undefined)
    conflictSet['practiceCorrect'] = updates.practiceCorrect;
  if (updates.proveScore !== undefined) conflictSet['proveScore'] = updates.proveScore;
  if (updates.proveAvgTime !== undefined) conflictSet['proveAvgTime'] = updates.proveAvgTime;

  const [row] = await db
    .insert(mwMathsProgress)
    .values({
      tenantId,
      memberId,
      operation,
      tableNumber,
      learnCompleted: updates.learnCompleted ?? false,
      practiceCorrect: updates.practiceCorrect ?? 0,
      proveScore: updates.proveScore ?? 0,
      proveAvgTime: updates.proveAvgTime ?? 0,
    })
    .onConflictDoUpdate({
      target: [
        mwMathsProgress.tenantId,
        mwMathsProgress.memberId,
        mwMathsProgress.operation,
        mwMathsProgress.tableNumber,
      ],
      set: conflictSet,
    })
    .returning();

  return serializeProgress(row!);
}

/** All certificate rows for this kid, DB order. */
export async function listCertificates(db: Database, tenantId: string, memberId: string) {
  const rows = await db
    .select()
    .from(mwMathsCertificates)
    .where(
      and(eq(mwMathsCertificates.tenantId, tenantId), eq(mwMathsCertificates.memberId, memberId)),
    );
  return rows.map(serializeCert);
}

/**
 * Award a certificate (idempotent).
 * Returns { certificate, alreadyEarned }.
 */
export async function awardCertificate(
  db: Database,
  tenantId: string,
  memberId: string,
  operation: MathsOperation,
  difficulty: string,
  totalCorrect: number,
): Promise<{ certificate: ReturnType<typeof serializeCert>; alreadyEarned: boolean }> {
  const [existing] = await db
    .select()
    .from(mwMathsCertificates)
    .where(
      and(
        eq(mwMathsCertificates.tenantId, tenantId),
        eq(mwMathsCertificates.memberId, memberId),
        eq(mwMathsCertificates.operation, operation),
        eq(mwMathsCertificates.difficulty, difficulty),
      ),
    )
    .limit(1);

  if (existing) {
    return { certificate: serializeCert(existing), alreadyEarned: true };
  }

  const [created] = await db
    .insert(mwMathsCertificates)
    .values({ tenantId, memberId, operation, difficulty, totalCorrect })
    .returning();

  return { certificate: serializeCert(created!), alreadyEarned: false };
}

// ─── Placement cascade (pure logic + DB) ──────────────────────────────────────

/**
 * Apply placement test results.
 *
 * For each result where `correct === true && timeSeconds <= 4`:
 *   master that table AND every table below it (1..tableNumber) for the
 *   operation. "Master" means:
 *     - upsert mw_maths_progress with learn_completed=true,
 *       practice_correct=10, prove_score=10, prove_avg_time=timeSeconds,
 *       placement_unlocked=true (idempotent: onConflictDoNothing so
 *       existing completed rows are not overwritten).
 *     - insert mw_maths_certificates for difficulty=String(tableNumber)
 *       (idempotent: onConflictDoNothing).
 *
 * Returns the set of tableNumbers unlocked by this call (deduplicated,
 * sorted ascending). A table already mastered before this call is NOT
 * included (doNothing = no rows touched = not in unlocked).
 */
export async function applyPlacement(
  db: Database,
  tenantId: string,
  memberId: string,
  operation: MathsOperation,
  results: { tableNumber: number; correct: boolean; timeSeconds: number }[],
): Promise<number[]> {
  const unlockedSet = new Set<number>();

  for (const result of results) {
    if (!result.correct || result.timeSeconds > PLACEMENT_TIME_THRESHOLD_SECONDS) continue;

    // Master every table from 1 up to result.tableNumber.
    for (let t = 1; t <= result.tableNumber; t++) {
      const [progressRow] = await db
        .insert(mwMathsProgress)
        .values({
          tenantId,
          memberId,
          operation,
          tableNumber: t,
          learnCompleted: true,
          practiceCorrect: PRACTICE_THRESHOLD,
          proveScore: PROVE_SCORE_THRESHOLD,
          proveAvgTime: result.timeSeconds,
          placementUnlocked: true,
        })
        .onConflictDoNothing()
        .returning();

      // Report EVERY table newly inserted, not just the trigger table.
      // This means tableNumber 3 qualifying returns unlocked = [1,2,3].
      if (progressRow) {
        unlockedSet.add(t);

        await db
          .insert(mwMathsCertificates)
          .values({
            tenantId,
            memberId,
            operation,
            difficulty: String(t),
            totalCorrect: PROVE_SCORE_THRESHOLD,
          })
          .onConflictDoNothing();
      }
    }
  }

  return [...unlockedSet].sort((a, b) => a - b);
}
