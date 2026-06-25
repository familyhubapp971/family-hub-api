// FHS-395 — unit tests for apps/api/src/lib/logic-progress.ts
//
// Tests server-authoritative grading: correct answer increments count,
// cert awarded at CERTIFICATE_THRESHOLD, wrong answer leaves count unchanged,
// second cert attempt is idempotent (returns false).
//
// No real Postgres — all DB calls use minimal inline mocks.

import { describe, it, expect, vi } from 'vitest';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSelectMock(rows: unknown[]) {
  return vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  });
}

function makeInsertMock(returning: unknown[] = []) {
  const onConflictDoNothing = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue(returning),
  });
  const onConflictDoUpdate = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue(returning),
  });
  const values = vi.fn().mockReturnValue({ onConflictDoNothing, onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  return { insert, onConflictDoNothing, onConflictDoUpdate, values };
}

import {
  CERTIFICATE_THRESHOLD,
  gradeAndRecord,
  awardCertificate,
} from '../../../../apps/api/src/lib/logic-progress.js';

import { getQuestionCounts } from '../../../../apps/api/src/lib/logic-questions.js';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// ─── Question bank shape ──────────────────────────────────────────────────────

describe('logic-questions — question bank sanity', () => {
  it('has questions for every gameType × difficulty', () => {
    const counts = getQuestionCounts();
    const gameTypes = ['truefalse', 'patterns', 'oddoneout', 'ifthen', 'sorting'] as const;
    const difficulties = ['easy', 'medium', 'hard'] as const;
    for (const gt of gameTypes) {
      for (const d of difficulties) {
        expect(counts[gt][d]).toBeGreaterThan(0);
      }
    }
  });

  it('every question has a non-empty id, type, and explanation', async () => {
    const { getRawQuestions, LOGIC_GAME_TYPES, LOGIC_DIFFICULTIES } = await import(
      '../../../../apps/api/src/lib/logic-questions.js'
    );
    for (const gt of LOGIC_GAME_TYPES) {
      for (const d of LOGIC_DIFFICULTIES) {
        const qs = getRawQuestions(gt, d);
        for (const q of qs) {
          expect(q.id).toBeTruthy();
          expect(q.type).toBe(gt);
          expect(q.explanation).toBeTruthy();
        }
      }
    }
  });
});

// ─── gradeAndRecord ───────────────────────────────────────────────────────────

describe('gradeAndRecord — correct answer increments count', () => {
  it('increments correctCount on a right answer', async () => {
    // Grab a real question so we can submit the real answer.
    const { getRawQuestions } = await import('../../../../apps/api/src/lib/logic-questions.js');
    const questions = getRawQuestions('truefalse', 'easy');
    const q = questions[0]!;

    // DB starts empty for this combo (no existing row).
    const selectRows: unknown[] = [];
    const newCount = 1;
    const { insert, onConflictDoUpdate } = makeInsertMock([
      {
        id: 'r1',
        tenantId: TENANT,
        memberId: MEMBER,
        gameType: 'truefalse',
        difficulty: 'easy',
        correctCount: newCount,
        updatedAt: new Date(),
      },
    ]);
    const db = {
      select: makeSelectMock(selectRows),
      insert,
    } as unknown as Parameters<typeof gradeAndRecord>[0];

    const result = await gradeAndRecord(db, TENANT, MEMBER, 'truefalse', 'easy', q.id, q.answer);

    expect(result.correct).toBe(true);
    expect(result.comboCorrect).toBe(newCount);
    expect(result.certificateEarned).toBe(false); // 1 < 10
    expect(insert).toHaveBeenCalledOnce();
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
  });

  it('does NOT increment correctCount on a wrong answer, but DOES increment totalAttempts', async () => {
    // FHS-401: wrong answers now call upsertProgress(delta=0, attemptsDelta=1)
    // so totalAttempts increments but correctCount stays the same.
    const { getRawQuestions } = await import('../../../../apps/api/src/lib/logic-questions.js');
    const questions = getRawQuestions('truefalse', 'easy');
    const q = questions[0]!;
    const wrongAnswer = !q.answer; // flip boolean

    const existingCount = 3;
    const existingAttempts = 5;
    const selectRows = [
      {
        id: 'p1',
        tenantId: TENANT,
        memberId: MEMBER,
        gameType: 'truefalse',
        difficulty: 'easy',
        correctCount: existingCount,
        totalAttempts: existingAttempts,
        updatedAt: new Date(),
      },
    ];
    // Wrong answer path now calls upsertProgress (insert with delta=0, attemptsDelta=1).
    const { insert, onConflictDoUpdate } = makeInsertMock([
      {
        id: 'p1',
        tenantId: TENANT,
        memberId: MEMBER,
        gameType: 'truefalse',
        difficulty: 'easy',
        correctCount: existingCount, // unchanged
        totalAttempts: existingAttempts + 1,
        updatedAt: new Date(),
      },
    ]);
    const db = {
      select: makeSelectMock(selectRows),
      insert,
    } as unknown as Parameters<typeof gradeAndRecord>[0];

    const result = await gradeAndRecord(db, TENANT, MEMBER, 'truefalse', 'easy', q.id, wrongAnswer);

    expect(result.correct).toBe(false);
    // comboCorrect = existingCount + 0 (delta=0 on wrong answers).
    expect(result.comboCorrect).toBe(existingCount);
    expect(result.certificateEarned).toBe(false);
    // insert IS now called — to increment totalAttempts.
    expect(insert).toHaveBeenCalledOnce();
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
  });
});

describe('gradeAndRecord — certificate at CERTIFICATE_THRESHOLD', () => {
  it(`awards a cert when correctCount reaches ${CERTIFICATE_THRESHOLD}`, async () => {
    const { getRawQuestions } = await import('../../../../apps/api/src/lib/logic-questions.js');
    const questions = getRawQuestions('truefalse', 'hard');
    const q = questions[0]!;

    const currentCount = CERTIFICATE_THRESHOLD - 1; // one away
    const newCount = CERTIFICATE_THRESHOLD;
    const existingProgressRow = [
      {
        id: 'p2',
        tenantId: TENANT,
        memberId: MEMBER,
        gameType: 'truefalse',
        difficulty: 'hard',
        correctCount: currentCount,
        updatedAt: new Date(),
      },
    ];
    // cert insert returns a row → newly awarded.
    const certRow = {
      id: 'c1',
      tenantId: TENANT,
      memberId: MEMBER,
      gameType: 'truefalse',
      difficulty: 'hard',
      totalCorrect: newCount,
      earnedAt: new Date(),
    };

    let selectCallCount = 0;
    const selectMock = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(() => {
            selectCallCount++;
            // First call: getProgress (existing row). Later calls not expected.
            return Promise.resolve(selectCallCount === 1 ? existingProgressRow : []);
          }),
        }),
      }),
    }));

    let insertCallCount = 0;
    const insertMock = vi.fn().mockImplementation(() => {
      insertCallCount++;
      if (insertCallCount === 1) {
        // upsert progress row
        return {
          values: vi.fn().mockReturnValue({
            onConflictDoUpdate: vi.fn().mockReturnValue({
              returning: vi
                .fn()
                .mockResolvedValue([{ ...existingProgressRow[0], correctCount: newCount }]),
            }),
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([certRow]),
            }),
          }),
        };
      }
      // cert insert
      return {
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([certRow]),
          }),
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([certRow]),
          }),
        }),
      };
    });

    const db = {
      select: selectMock,
      insert: insertMock,
    } as unknown as Parameters<typeof gradeAndRecord>[0];

    const result = await gradeAndRecord(db, TENANT, MEMBER, 'truefalse', 'hard', q.id, q.answer);

    expect(result.correct).toBe(true);
    expect(result.comboCorrect).toBe(newCount);
    expect(result.certificateEarned).toBe(true);
  });
});

describe('gradeAndRecord — unknown question throws', () => {
  it('throws with "Question not found" message for bad questionId', async () => {
    const { insert } = makeInsertMock([]);
    const db = {
      select: makeSelectMock([]),
      insert,
    } as unknown as Parameters<typeof gradeAndRecord>[0];

    await expect(
      gradeAndRecord(db, TENANT, MEMBER, 'truefalse', 'easy', 'nonexistent-id', true),
    ).rejects.toThrow('Question not found');
  });
});

// ─── upsertProgress — attempt counter (FHS-401) ──────────────────────────────

describe('upsertProgress — totalAttempts counter', () => {
  it('increments totalAttempts on correct answer (delta=1, attemptsDelta=1)', async () => {
    const { upsertProgress } = await import('../../../../apps/api/src/lib/logic-progress.js');

    const existingRow = {
      id: 'r1',
      tenantId: TENANT,
      memberId: MEMBER,
      gameType: 'truefalse',
      difficulty: 'easy',
      correctCount: 5,
      totalAttempts: 8,
      updatedAt: new Date(),
    };

    const { insert, onConflictDoUpdate, values } = makeInsertMock([
      { ...existingRow, correctCount: 6, totalAttempts: 9 },
    ]);
    const db = {
      select: makeSelectMock([existingRow]),
      insert,
    } as unknown as Parameters<typeof upsertProgress>[0];

    const newCount = await upsertProgress(db, TENANT, MEMBER, 'truefalse', 'easy', 1, 1);

    expect(newCount).toBe(6);
    expect(insert).toHaveBeenCalledOnce();
    // The values passed to insert should include totalAttempts = 9 (8+1).
    const insertedValues = (values.mock.calls[0] as [Record<string, unknown>][])[0];
    expect(insertedValues?.totalAttempts).toBe(9);
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
  });

  it('increments totalAttempts but NOT correctCount on wrong answer (delta=0, attemptsDelta=1)', async () => {
    const { upsertProgress } = await import('../../../../apps/api/src/lib/logic-progress.js');

    const existingRow = {
      id: 'r2',
      tenantId: TENANT,
      memberId: MEMBER,
      gameType: 'patterns',
      difficulty: 'hard',
      correctCount: 3,
      totalAttempts: 7,
      updatedAt: new Date(),
    };

    const { insert, values } = makeInsertMock([
      { ...existingRow, correctCount: 3, totalAttempts: 8 },
    ]);
    const db = {
      select: makeSelectMock([existingRow]),
      insert,
    } as unknown as Parameters<typeof upsertProgress>[0];

    const newCount = await upsertProgress(db, TENANT, MEMBER, 'patterns', 'hard', 0, 1);

    expect(newCount).toBe(3); // correctCount unchanged
    const insertedValues = (values.mock.calls[0] as [Record<string, unknown>][])[0];
    expect(insertedValues?.correctCount).toBe(3);
    expect(insertedValues?.totalAttempts).toBe(8); // was 7, now 8
  });
});

// ─── awardCertificate — idempotency ──────────────────────────────────────────

describe('awardCertificate — idempotent', () => {
  it('returns false when cert already exists (onConflictDoNothing returns [])', async () => {
    const onConflictDoNothing = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([]), // empty = already existed
    });
    const insertMock = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ onConflictDoNothing }),
    });
    const db = { insert: insertMock } as unknown as Parameters<typeof awardCertificate>[0];

    const earned = await awardCertificate(db, TENANT, MEMBER, 'sorting', 'hard', 15);
    expect(earned).toBe(false);
  });

  it('returns true when cert is newly inserted', async () => {
    const newCert = {
      id: 'nc1',
      tenantId: TENANT,
      memberId: MEMBER,
      gameType: 'sorting',
      difficulty: 'hard',
      totalCorrect: 10,
      earnedAt: new Date(),
    };
    const onConflictDoNothing = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([newCert]),
    });
    const insertMock = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ onConflictDoNothing }),
    });
    const db = { insert: insertMock } as unknown as Parameters<typeof awardCertificate>[0];

    const earned = await awardCertificate(db, TENANT, MEMBER, 'sorting', 'hard', 10);
    expect(earned).toBe(true);
  });
});
