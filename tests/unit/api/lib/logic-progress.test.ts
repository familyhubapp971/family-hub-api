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

  it('does NOT increment count on a wrong answer', async () => {
    const { getRawQuestions } = await import('../../../../apps/api/src/lib/logic-questions.js');
    const questions = getRawQuestions('truefalse', 'easy');
    const q = questions[0]!;
    const wrongAnswer = !q.answer; // flip boolean

    const existingCount = 3;
    const selectRows = [
      {
        id: 'p1',
        tenantId: TENANT,
        memberId: MEMBER,
        gameType: 'truefalse',
        difficulty: 'easy',
        correctCount: existingCount,
        updatedAt: new Date(),
      },
    ];
    const { insert } = makeInsertMock([]);
    const db = {
      select: makeSelectMock(selectRows),
      insert,
    } as unknown as Parameters<typeof gradeAndRecord>[0];

    const result = await gradeAndRecord(db, TENANT, MEMBER, 'truefalse', 'easy', q.id, wrongAnswer);

    expect(result.correct).toBe(false);
    // comboCorrect reflects the existing (unchanged) count.
    expect(result.comboCorrect).toBe(existingCount);
    expect(result.certificateEarned).toBe(false);
    expect(insert).not.toHaveBeenCalled();
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
