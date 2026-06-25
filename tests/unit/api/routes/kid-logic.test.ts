// FHS-395 — unit tests for the kid Logic endpoints.
//
// Endpoints under test:
//   GET  /api/kid/logic/questions?gameType=&difficulty=
//   POST /api/kid/logic/answer
//   GET  /api/kid/logic/certificates
//
// Auth checks: 403 with no token, 401 with expired token, 403 non-child scope.
// Validation checks: 400 on bad gameType/difficulty/body.
// Happy paths: correct status + response shape (mocked DB).

import { SignJWT } from 'jose';
import { Hono } from 'hono';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../../../../apps/api/src/config.js';
import { KID_ISSUER } from '../../../../apps/api/src/middleware/kid-auth.js';

// ─── DB mock ──────────────────────────────────────────────────────────────────

const dbMock = {
  select: vi.fn(),
  insert: vi.fn(),
};

vi.mock('../../../../apps/api/src/db/client.js', () => ({
  getDb: () => dbMock,
  pinRequestTenant: async () => {},
}));

const { kidRouter } = await import('../../../../apps/api/src/routes/kid.js');

// ─── Token helpers ────────────────────────────────────────────────────────────

const KEY = new TextEncoder().encode(config.KID_AUTH_SECRET);
const MEMBER_ID = '44444444-4444-4444-8444-444444444444';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_SLUG = 'test-fam';

async function mintKidToken(secondsFromNow = 3600): Promise<string> {
  return new SignJWT({ scope: 'child', tenantId: TENANT_ID, tenantSlug: TENANT_SLUG })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(MEMBER_ID)
    .setIssuer(KID_ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + secondsFromNow)
    .sign(KEY);
}

async function mintNonChildToken(): Promise<string> {
  return new SignJWT({ scope: 'parent', tenantId: TENANT_ID, tenantSlug: TENANT_SLUG })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(MEMBER_ID)
    .setIssuer(KID_ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(KEY);
}

function buildApp() {
  const app = new Hono();
  app.route('/api/kid', kidRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
});

// ─── Auth guards ──────────────────────────────────────────────────────────────

describe('FHS-395 — auth guards', () => {
  const endpoints: [string, string, object | undefined][] = [
    ['GET', '/api/kid/logic/questions?gameType=truefalse&difficulty=easy', undefined],
    [
      'POST',
      '/api/kid/logic/answer',
      { gameType: 'truefalse', difficulty: 'easy', questionId: 'x', answer: true },
    ],
    ['GET', '/api/kid/logic/certificates', undefined],
  ];

  it.each(endpoints)('%s %s — 403 with no token', async (method, path) => {
    const res = await buildApp().request(path, { method });
    expect(res.status).toBe(403);
  });

  it.each(endpoints)('%s %s — 401 with expired token', async (method, path, body) => {
    const token = await mintKidToken(-10);
    const res = await buildApp().request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(res.status).toBe(401);
  });

  it('GET /api/kid/logic/questions — 403 with non-child scope', async () => {
    const token = await mintNonChildToken();
    const res = await buildApp().request(
      '/api/kid/logic/questions?gameType=truefalse&difficulty=easy',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(403);
  });
});

// ─── GET /api/kid/logic/questions ────────────────────────────────────────────

describe('FHS-395 — GET /api/kid/logic/questions', () => {
  it('400 when gameType is missing', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/logic/questions?difficulty=easy', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  it('400 when difficulty is missing', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/logic/questions?gameType=truefalse', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  it('400 when gameType is invalid', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request(
      '/api/kid/logic/questions?gameType=notvalid&difficulty=easy',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(400);
  });

  it('400 when difficulty is invalid', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request(
      '/api/kid/logic/questions?gameType=truefalse&difficulty=extreme',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(400);
  });

  it('200 + questions array with answers stripped on valid combo', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request(
      '/api/kid/logic/questions?gameType=truefalse&difficulty=easy',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { questions: Record<string, unknown>[] };
    expect(Array.isArray(body.questions)).toBe(true);
    expect(body.questions.length).toBeGreaterThan(0);
    // Answers must be stripped.
    for (const q of body.questions) {
      expect(q).not.toHaveProperty('answer');
      expect(q).toHaveProperty('id');
      expect(q).toHaveProperty('type');
      expect(q).toHaveProperty('explanation');
    }
  });

  it('200 for all 5 game types on easy', async () => {
    const token = await mintKidToken();
    const gameTypes = ['truefalse', 'patterns', 'oddoneout', 'ifthen', 'sorting'];
    for (const gt of gameTypes) {
      const res = await buildApp().request(
        `/api/kid/logic/questions?gameType=${gt}&difficulty=easy`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { questions: unknown[] };
      expect(body.questions.length).toBeGreaterThan(0);
    }
  });
});

// ─── POST /api/kid/logic/answer ──────────────────────────────────────────────

describe('FHS-395 — POST /api/kid/logic/answer', () => {
  it('400 when body is empty', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/logic/answer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('400 when gameType is invalid', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/logic/answer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameType: 'badtype',
        difficulty: 'easy',
        questionId: 'x',
        answer: true,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('400 when difficulty is invalid', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/logic/answer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameType: 'truefalse',
        difficulty: 'expert',
        questionId: 'x',
        answer: true,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('400 when questionId is missing', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/logic/answer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameType: 'truefalse', difficulty: 'easy', answer: true }),
    });
    expect(res.status).toBe(400);
  });

  it('400 when questionId is unknown', async () => {
    // gradeAndRecord throws "Question not found" → handler returns 400.
    // DB won't be called because the throw happens in the question-bank lookup.
    const token = await mintKidToken();
    // Provide valid game params but an id that doesn't exist.
    const res = await buildApp().request('/api/kid/logic/answer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameType: 'truefalse',
        difficulty: 'easy',
        questionId: 'does-not-exist',
        answer: true,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('200 on correct answer with a real question from the bank', async () => {
    const { getRawQuestions } = await import('../../../../apps/api/src/lib/logic-questions.js');
    const qs = getRawQuestions('truefalse', 'easy');
    const q = qs[0]!;

    // Mock the DB for the progress upsert path (no existing row → correctCount=1 < 10).
    // select().from().where().limit() returns [] (no existing row)
    dbMock.select.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }));
    // insert().values().onConflictDoUpdate().returning() returns new row
    dbMock.insert.mockImplementation(() => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: () =>
            Promise.resolve([
              {
                id: 'pr1',
                tenantId: TENANT_ID,
                memberId: MEMBER_ID,
                gameType: 'truefalse',
                difficulty: 'easy',
                correctCount: 1,
                updatedAt: new Date(),
              },
            ]),
        }),
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }));

    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/logic/answer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameType: 'truefalse',
        difficulty: 'easy',
        questionId: q.id,
        answer: q.answer,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      correct: boolean;
      comboCorrect: number;
      certificateEarned: boolean;
    };
    expect(body.correct).toBe(true);
    expect(body.comboCorrect).toBe(1);
    expect(body.certificateEarned).toBe(false);
  });

  it('200 with correct:false when wrong answer submitted', async () => {
    const { getRawQuestions } = await import('../../../../apps/api/src/lib/logic-questions.js');
    const qs = getRawQuestions('truefalse', 'easy');
    const q = qs[0]!;
    const wrongAnswer = !q.answer; // flip the boolean

    // FHS-401: wrong answers now call upsertProgress (delta=0, attemptsDelta=1),
    // so both select and insert must be mocked.
    dbMock.select.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }));
    dbMock.insert.mockImplementation(() => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: () =>
            Promise.resolve([
              {
                id: 'p1',
                tenantId: TENANT_ID,
                memberId: MEMBER_ID,
                gameType: 'truefalse',
                difficulty: 'easy',
                correctCount: 0,
                totalAttempts: 1,
                updatedAt: new Date(),
              },
            ]),
        }),
      }),
    }));

    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/logic/answer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameType: 'truefalse',
        difficulty: 'easy',
        questionId: q.id,
        answer: wrongAnswer,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { correct: boolean };
    expect(body.correct).toBe(false);
  });

  // #4a — cross-combo boundary: truefalse/easy questionId submitted under sorting/easy → 400
  it('400 when truefalse/easy questionId is submitted with gameType sorting', async () => {
    const { getRawQuestions } = await import('../../../../apps/api/src/lib/logic-questions.js');
    const tfQ = getRawQuestions('truefalse', 'easy')[0]!;

    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/logic/answer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // tfQ.id is e.g. "truefalse-easy-1" — won't be found in sorting/easy bank.
      body: JSON.stringify({
        gameType: 'sorting',
        difficulty: 'easy',
        questionId: tfQ.id,
        answer: 'Fruits',
      }),
    });
    expect(res.status).toBe(400);
  });

  // #4b — replay same correct questionId 10x → comboCorrect 10 + certificateEarned true on 10th
  it('replaying same correct questionId 10 times awards cert on 10th', async () => {
    const { getRawQuestions } = await import('../../../../apps/api/src/lib/logic-questions.js');
    const q = getRawQuestions('truefalse', 'easy')[0]!;
    const token = await mintKidToken();

    let callCount = 0;
    dbMock.select.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: () => {
            // Return increasing correctCount to simulate accumulated progress.
            return Promise.resolve(
              callCount === 0
                ? []
                : [
                    {
                      id: 'pr',
                      tenantId: TENANT_ID,
                      memberId: MEMBER_ID,
                      gameType: 'truefalse',
                      difficulty: 'easy',
                      correctCount: callCount,
                      updatedAt: new Date(),
                    },
                  ],
            );
          },
        }),
      }),
    }));

    dbMock.insert.mockImplementation(() => {
      callCount++;
      const newCount = callCount;
      return {
        values: () => ({
          onConflictDoUpdate: () => ({
            returning: () =>
              Promise.resolve([
                {
                  id: 'pr',
                  tenantId: TENANT_ID,
                  memberId: MEMBER_ID,
                  gameType: 'truefalse',
                  difficulty: 'easy',
                  correctCount: newCount,
                  updatedAt: new Date(),
                },
              ]),
          }),
          onConflictDoNothing: () => ({
            returning: () =>
              Promise.resolve(
                newCount >= 10
                  ? [
                      {
                        id: 'c1',
                        tenantId: TENANT_ID,
                        memberId: MEMBER_ID,
                        gameType: 'truefalse',
                        difficulty: 'easy',
                        totalCorrect: newCount,
                        earnedAt: new Date(),
                      },
                    ]
                  : [],
              ),
          }),
        }),
      };
    });

    let lastBody: { correct: boolean; comboCorrect: number; certificateEarned: boolean } | null =
      null;
    for (let i = 0; i < 10; i++) {
      const res = await buildApp().request('/api/kid/logic/answer', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gameType: 'truefalse',
          difficulty: 'easy',
          questionId: q.id,
          answer: q.answer,
        }),
      });
      expect(res.status).toBe(200);
      lastBody = (await res.json()) as typeof lastBody;
    }
    expect(lastBody!.correct).toBe(true);
    expect(lastBody!.comboCorrect).toBe(10);
    expect(lastBody!.certificateEarned).toBe(true);
  });

  // #4c — boolean answer (true) to a string-answer game (sorting) → correct:false
  it('boolean answer against a string-answer sorting question returns correct:false', async () => {
    const { getRawQuestions } = await import('../../../../apps/api/src/lib/logic-questions.js');
    const sortQ = getRawQuestions('sorting', 'easy')[0]!;

    // FHS-401: wrong answers call upsertProgress — mock both select and insert.
    dbMock.select.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }));
    dbMock.insert.mockImplementation(() => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: () =>
            Promise.resolve([
              {
                id: 'p1',
                tenantId: TENANT_ID,
                memberId: MEMBER_ID,
                gameType: 'sorting',
                difficulty: 'easy',
                correctCount: 0,
                totalAttempts: 1,
                updatedAt: new Date(),
              },
            ]),
        }),
      }),
    }));

    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/logic/answer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // Sorting answers are strings (e.g. "Fruits") — boolean true must never match.
      body: JSON.stringify({
        gameType: 'sorting',
        difficulty: 'easy',
        questionId: sortQ.id,
        answer: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { correct: boolean };
    expect(body.correct).toBe(false);
  });
});

// ─── GET /api/kid/logic/certificates ─────────────────────────────────────────

describe('FHS-395 — GET /api/kid/logic/certificates', () => {
  it('200 + empty array when no certs exist', async () => {
    dbMock.select.mockImplementation(() => ({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    }));
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/logic/certificates', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { certificates: unknown[] };
    expect(body.certificates).toHaveLength(0);
  });

  it('200 + cert rows when certs exist', async () => {
    const cert = {
      id: 'cc111111-1111-4111-8111-111111111111',
      tenantId: TENANT_ID,
      memberId: MEMBER_ID,
      gameType: 'truefalse',
      difficulty: 'easy',
      totalCorrect: 10,
      earnedAt: new Date('2026-01-01T00:00:00Z'),
    };
    // listLogicCertificates: select().from().where() → Promise<row[]>
    dbMock.select.mockImplementation(() => ({
      from: () => ({
        where: () => Promise.resolve([cert]),
      }),
    }));
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/logic/certificates', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { certificates: Array<{ gameType: string }> };
    expect(body.certificates).toHaveLength(1);
    expect(body.certificates[0]!.gameType).toBe('truefalse');
  });
});
