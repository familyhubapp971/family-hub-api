// FHS-394 — unit tests for apps/api/src/lib/maths-progress.ts
//
// Covers:
//  1. applyPlacement — cascade logic (pure, DB mocked)
//  2. upsertProgress — partial-field update behaviour
//  3. awardCertificate — idempotency
//
// No real Postgres. All DB calls go through a mock chain.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── DB mock ──────────────────────────────────────────────────────────────────

// We need a chainable mock: db.insert().values().onConflictDoNothing().returning()
// Each test constructs the mock for its specific call-path.

function makeInsertMock(returning: unknown[] = []) {
  return vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(returning),
      }),
      onConflictDoUpdate: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(returning),
      }),
    }),
  });
}

function makeSelectMock(result: unknown[]) {
  return vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result),
      }),
    }),
  });
}

// ─── Import helpers after mock setup ─────────────────────────────────────────

// We import directly — no module-level mock needed because the helpers accept
// a `db` argument rather than calling getDb() internally.
import {
  applyPlacement,
  upsertProgress,
  awardCertificate,
  PRACTICE_THRESHOLD,
  PROVE_SCORE_THRESHOLD,
  PLACEMENT_TIME_THRESHOLD_SECONDS,
} from '../../../../apps/api/src/lib/maths-progress.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';

// ─── applyPlacement ───────────────────────────────────────────────────────────

describe('applyPlacement — cascade logic', () => {
  it('masters a table and all tables below when correct + timeSeconds <= 4', async () => {
    // Simulate a fresh DB: insert returns a row (signalling new insertion).
    const fakeRow = {
      id: 'aaa',
      tenantId: TENANT,
      memberId: MEMBER,
      operation: 'addition',
      tableNumber: 3,
      learnCompleted: true,
      practiceCorrect: PRACTICE_THRESHOLD,
      proveScore: PROVE_SCORE_THRESHOLD,
      proveAvgTime: 3,
      placementUnlocked: true,
      updatedAt: new Date(),
    };

    let callCount = 0;
    const insertMock = vi.fn().mockImplementation(() => ({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockImplementation(() => {
            callCount++;
            return Promise.resolve([{ ...fakeRow, tableNumber: callCount }]);
          }),
        }),
      }),
    }));

    const db = {
      insert: insertMock,
    } as unknown as Parameters<typeof applyPlacement>[0];

    const unlocked = await applyPlacement(db, TENANT, MEMBER, 'addition', [
      { tableNumber: 3, correct: true, timeSeconds: 3 },
    ]);

    // Should have unlocked table 3 (the highest triggered).
    expect(unlocked).toContain(3);
    // insert should have been called 6 times: 3 progress + 3 cert rows.
    expect(insertMock).toHaveBeenCalledTimes(6);
  });

  it('does not unlock a table when correct but timeSeconds > 4', async () => {
    const insertMock = makeInsertMock([]);
    const db = { insert: insertMock } as unknown as Parameters<typeof applyPlacement>[0];

    const unlocked = await applyPlacement(db, TENANT, MEMBER, 'multiplication', [
      { tableNumber: 5, correct: true, timeSeconds: 5 },
    ]);

    expect(unlocked).toHaveLength(0);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('does not unlock a table when timeSeconds is in range but correct is false', async () => {
    const insertMock = makeInsertMock([]);
    const db = { insert: insertMock } as unknown as Parameters<typeof applyPlacement>[0];

    const unlocked = await applyPlacement(db, TENANT, MEMBER, 'subtraction', [
      { tableNumber: 7, correct: false, timeSeconds: 2 },
    ]);

    expect(unlocked).toHaveLength(0);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('excludes already-mastered tables (onConflictDoNothing returns [])', async () => {
    // When the row already exists, onConflictDoNothing returns [] (no insert).
    const insertMock = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]), // existing row — no new insert
        }),
      }),
    });

    const db = { insert: insertMock } as unknown as Parameters<typeof applyPlacement>[0];

    const unlocked = await applyPlacement(db, TENANT, MEMBER, 'division', [
      { tableNumber: 2, correct: true, timeSeconds: 1 },
    ]);

    // No NEW rows were inserted → nothing added to unlocked.
    expect(unlocked).toHaveLength(0);
  });

  it('returns unlocked list sorted ascending when multiple tables are hit', async () => {
    // Two results: table 1 (wrong) and table 3 (fast). Only table 3 cascades,
    // but the cascade inserts t=1, t=2, t=3 → unlocked = [1,2,3].
    let insertCallCount = 0;
    const insertMock = vi.fn().mockImplementation(() => ({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockImplementation(() => {
            insertCallCount++;
            return Promise.resolve([
              {
                id: 'x',
                tenantId: TENANT,
                memberId: MEMBER,
                operation: 'addition',
                tableNumber: insertCallCount,
                learnCompleted: true,
                practiceCorrect: 10,
                proveScore: 10,
                proveAvgTime: 3,
                placementUnlocked: true,
                updatedAt: new Date(),
              },
            ]);
          }),
        }),
      }),
    }));

    const db = { insert: insertMock } as unknown as Parameters<typeof applyPlacement>[0];

    const unlocked = await applyPlacement(db, TENANT, MEMBER, 'addition', [
      { tableNumber: 1, correct: false, timeSeconds: 2 },
      { tableNumber: 3, correct: true, timeSeconds: 3 },
    ]);

    // Table 3 triggers the cascade → tables 1,2,3 newly inserted.
    expect(unlocked).toEqual([1, 2, 3]);
  });

  // ─── Boundary: exactly at the threshold (≤4s unlocks; >4s does not) ──────────

  it(`unlocks when timeSeconds === ${PLACEMENT_TIME_THRESHOLD_SECONDS} (at the boundary)`, async () => {
    const fakeRow = {
      id: 'e1',
      tenantId: TENANT,
      memberId: MEMBER,
      operation: 'addition',
      tableNumber: 1,
      learnCompleted: true,
      practiceCorrect: PRACTICE_THRESHOLD,
      proveScore: PROVE_SCORE_THRESHOLD,
      proveAvgTime: PLACEMENT_TIME_THRESHOLD_SECONDS,
      placementUnlocked: true,
      updatedAt: new Date(),
    };
    const insertMock = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([fakeRow]),
        }),
      }),
    });
    const db = { insert: insertMock } as unknown as Parameters<typeof applyPlacement>[0];

    const unlocked = await applyPlacement(db, TENANT, MEMBER, 'addition', [
      { tableNumber: 1, correct: true, timeSeconds: PLACEMENT_TIME_THRESHOLD_SECONDS },
    ]);

    expect(unlocked).toContain(1);
  });

  it('does NOT unlock when timeSeconds is just above the threshold', async () => {
    const insertMock = makeInsertMock([]);
    const db = { insert: insertMock } as unknown as Parameters<typeof applyPlacement>[0];

    const unlocked = await applyPlacement(db, TENANT, MEMBER, 'addition', [
      // 4.001 > 4 — should be filtered out before any DB call.
      { tableNumber: 1, correct: true, timeSeconds: 4.001 },
    ]);

    expect(unlocked).toHaveLength(0);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('single result tableNumber:3 on blank slate returns unlocked containing 1,2,3', async () => {
    let t = 0;
    const insertMock = vi.fn().mockImplementation(() => ({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockImplementation(() => {
            t++;
            return Promise.resolve([
              {
                id: `row-${t}`,
                tenantId: TENANT,
                memberId: MEMBER,
                operation: 'multiplication',
                tableNumber: t,
                learnCompleted: true,
                practiceCorrect: PRACTICE_THRESHOLD,
                proveScore: PROVE_SCORE_THRESHOLD,
                proveAvgTime: 2,
                placementUnlocked: true,
                updatedAt: new Date(),
              },
            ]);
          }),
        }),
      }),
    }));

    const db = { insert: insertMock } as unknown as Parameters<typeof applyPlacement>[0];

    const unlocked = await applyPlacement(db, TENANT, MEMBER, 'multiplication', [
      { tableNumber: 3, correct: true, timeSeconds: 2 },
    ]);

    expect(unlocked).toEqual([1, 2, 3]);
  });
});

// ─── upsertProgress — partial-field updates ───────────────────────────────────

describe('upsertProgress — partial-field updates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('only includes supplied fields in the conflict set', async () => {
    const fakeRow = {
      id: 'bbb',
      tenantId: TENANT,
      memberId: MEMBER,
      operation: 'addition',
      tableNumber: 1,
      learnCompleted: false,
      practiceCorrect: 5,
      proveScore: 0,
      proveAvgTime: 0,
      placementUnlocked: false,
      updatedAt: new Date(),
    };

    const onConflictDoUpdate = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([fakeRow]),
    });
    const insertMock = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate,
      }),
    });

    const db = { insert: insertMock } as unknown as Parameters<typeof upsertProgress>[0];

    const result = await upsertProgress(db, TENANT, MEMBER, 'addition', 1, {
      practiceCorrect: 5,
    });

    // onConflictDoUpdate was called (upsert path).
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();

    const callArg = onConflictDoUpdate.mock.calls[0]![0] as {
      target: unknown[];
      set: Record<string, unknown>;
    };

    // The conflict set includes practiceCorrect but NOT learnCompleted, proveScore, proveAvgTime.
    expect(callArg.set).toHaveProperty('practiceCorrect', 5);
    expect(callArg.set).not.toHaveProperty('learnCompleted');
    expect(callArg.set).not.toHaveProperty('proveScore');
    expect(callArg.set).not.toHaveProperty('proveAvgTime');

    // The returned row is serialised correctly.
    expect(result.practiceCorrect).toBe(5);
  });
});

// ─── awardCertificate — idempotency ──────────────────────────────────────────

describe('awardCertificate — idempotency', () => {
  it('returns alreadyEarned:true when the cert already exists', async () => {
    const existing = {
      id: 'ccc',
      tenantId: TENANT,
      memberId: MEMBER,
      operation: 'multiplication',
      difficulty: '5',
      totalCorrect: 10,
      earnedAt: new Date(),
    };

    const selectMock = makeSelectMock([existing]);
    const insertMock = vi.fn();
    const db = { select: selectMock, insert: insertMock } as unknown as Parameters<
      typeof awardCertificate
    >[0];

    const result = await awardCertificate(db, TENANT, MEMBER, 'multiplication', '5', 10);

    expect(result.alreadyEarned).toBe(true);
    expect(result.certificate.difficulty).toBe('5');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('inserts a new cert and returns alreadyEarned:false when not present', async () => {
    const created = {
      id: 'ddd',
      tenantId: TENANT,
      memberId: MEMBER,
      operation: 'addition',
      difficulty: 'easy',
      totalCorrect: 12,
      earnedAt: new Date(),
    };

    const selectMock = makeSelectMock([]); // no existing row
    const insertMock = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([created]),
      }),
    });

    const db = { select: selectMock, insert: insertMock } as unknown as Parameters<
      typeof awardCertificate
    >[0];

    const result = await awardCertificate(db, TENANT, MEMBER, 'addition', 'easy', 12);

    expect(result.alreadyEarned).toBe(false);
    expect(result.certificate.difficulty).toBe('easy');
    expect(insertMock).toHaveBeenCalledOnce();
  });
});
