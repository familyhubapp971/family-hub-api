/**
 * Step bindings for kid-logic.feature (FHS-395).
 *
 * Kid identity from kid token (no memberId param). Real Postgres on :5433.
 * Mirrors the kid-maths.steps.ts pattern: kidRouter + mintKidToken +
 * no-op pinRequestTenant mock.
 */

import { randomUUID } from 'node:crypto';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
  pinRequestTenant: async () => {},
}));

import { config } from '../../../apps/api/src/config.js';
import { kidRouter } from '../../../apps/api/src/routes/kid.js';
import { tenants, members } from '../../../apps/api/src/db/schema.js';
import { getRawQuestions } from '../../../apps/api/src/lib/logic-questions.js';
import type { Database } from '../../../apps/api/src/db/client.js';

const KID_ISSUER = 'family-hub-kid-auth';

let db: Database;
let app: Hono;
const tokens = new Map<string, string>();

// Last HTTP response captured per operation.
let questionsRes: Response;
let answerRes: Response;
let certsGetRes: Response;

// Parsed response bodies.
let questionsBody: { questions: Array<Record<string, unknown>> };
let answerBody: {
  correct: boolean;
  correctAnswer: unknown;
  explanation: string;
  comboCorrect: number;
  certificateEarned: boolean;
};
let certsBody: { certificates: Array<Record<string, unknown>> };

// Current question under test (set by "Alex fetches a question" steps).
let currentQuestion: { id: string; answer: unknown; type: string };

async function mintKidToken(memberId: string, tenantId: string, slug: string): Promise<string> {
  const secret = new TextEncoder().encode(config.KID_AUTH_SECRET);
  return new SignJWT({ tenantId, tenantSlug: slug, scope: 'child' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(memberId)
    .setIssuer(KID_ISSUER)
    .setExpirationTime('1h')
    .sign(secret);
}

const authFor = (name: string) => ({ Authorization: `Bearer ${tokens.get(name)}` });
const jsonAuth = (name: string) => ({ ...authFor(name), 'Content-Type': 'application/json' });

const feature = await loadFeature(
  new URL('../features/kid-logic.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given, And }) => {
    Given('a family with logic kid "Alex" in tenant "logic-fam"', async () => {
      db = getTestDb() as unknown as Database;

      // Clean slate for every scenario.
      await db.execute(sql`TRUNCATE TABLE mw_logic_certificates RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE mw_logic_progress RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);

      const [t] = await db
        .insert(tenants)
        .values({ slug: `logic-fam-${randomUUID().slice(0, 8)}`, name: 'Logic Fam' })
        .returning();

      const [alex] = await db
        .insert(members)
        .values({ tenantId: t!.id, displayName: 'Alex', role: 'child', isChild: true })
        .returning();

      tokens.set('Alex', await mintKidToken(alex!.id, t!.id, t!.slug));

      app = new Hono();
      app.route('/api/kid', kidRouter);
    });

    And('a second logic tenant with kid "Sam" in tenant "logic-other-fam"', async () => {
      const [t2] = await db
        .insert(tenants)
        .values({ slug: `logic-other-${randomUUID().slice(0, 8)}`, name: 'Logic Other Fam' })
        .returning();

      const [sam] = await db
        .insert(members)
        .values({ tenantId: t2!.id, displayName: 'Sam', role: 'child', isChild: true })
        .returning();

      tokens.set('Sam', await mintKidToken(sam!.id, t2!.id, t2!.slug));
    });
  });

  // ─── GET /api/kid/logic/questions: happy path ────────────────────────────────

  Scenario(
    'GET /api/kid/logic/questions returns questions with answers stripped',
    ({ When, Then, And }) => {
      When(
        '"Alex" GETs /api/kid/logic/questions with gameType "truefalse" difficulty "easy"',
        async () => {
          questionsRes = await app.request(
            '/api/kid/logic/questions?gameType=truefalse&difficulty=easy',
            { headers: authFor('Alex') },
          );
          questionsBody = (await questionsRes.json()) as typeof questionsBody;
        },
      );
      Then('the logic questions response status is 200', () =>
        expect(questionsRes.status).toBe(200),
      );
      And('the logic questions response has a non-empty questions array', () =>
        expect(questionsBody.questions.length).toBeGreaterThan(0),
      );
      And('no question in the response has an "answer" field', () => {
        for (const q of questionsBody.questions) {
          expect(q).not.toHaveProperty('answer');
        }
      });
    },
  );

  // ─── GET /api/kid/logic/questions: 400 on invalid gameType ──────────────────

  Scenario('400 on invalid gameType', ({ When, Then }) => {
    When(
      '"Alex" GETs /api/kid/logic/questions with gameType "invalid" difficulty "easy"',
      async () => {
        questionsRes = await app.request(
          '/api/kid/logic/questions?gameType=invalid&difficulty=easy',
          { headers: authFor('Alex') },
        );
      },
    );
    Then('the logic questions response status is 400', () => expect(questionsRes.status).toBe(400));
  });

  // ─── GET /api/kid/logic/questions: 400 on invalid difficulty ────────────────

  Scenario('400 on invalid difficulty', ({ When, Then }) => {
    When(
      '"Alex" GETs /api/kid/logic/questions with gameType "truefalse" difficulty "extreme"',
      async () => {
        questionsRes = await app.request(
          '/api/kid/logic/questions?gameType=truefalse&difficulty=extreme',
          { headers: authFor('Alex') },
        );
      },
    );
    Then('the logic questions response status is 400', () => expect(questionsRes.status).toBe(400));
  });

  // ─── POST /api/kid/logic/answer: correct answer ─────────────────────────────

  Scenario('correct answer increments combo progress', ({ Given, When, Then, And }) => {
    Given('"Alex" fetches a truefalse easy question', async () => {
      const qs = getRawQuestions('truefalse', 'easy');
      const q = qs[0]!;
      currentQuestion = { id: q.id, answer: q.answer, type: q.type };
    });
    When('"Alex" POSTs the correct answer to /api/kid/logic/answer', async () => {
      answerRes = await app.request('/api/kid/logic/answer', {
        method: 'POST',
        headers: jsonAuth('Alex'),
        body: JSON.stringify({
          gameType: 'truefalse',
          difficulty: 'easy',
          questionId: currentQuestion.id,
          answer: currentQuestion.answer,
        }),
      });
      answerBody = (await answerRes.json()) as typeof answerBody;
    });
    Then('the logic answer response status is 200', () => expect(answerRes.status).toBe(200));
    And('the logic answer body has correct true', () => expect(answerBody.correct).toBe(true));
    And('the logic answer body has comboCorrect 1', () => expect(answerBody.comboCorrect).toBe(1));
    And('the logic answer body has certificateEarned false', () =>
      expect(answerBody.certificateEarned).toBe(false),
    );
  });

  // ─── POST /api/kid/logic/answer: wrong answer ───────────────────────────────

  Scenario('wrong answer does not increment combo progress', ({ Given, When, Then, And }) => {
    Given('"Alex" fetches a truefalse easy question', async () => {
      const qs = getRawQuestions('truefalse', 'easy');
      const q = qs[0]!;
      currentQuestion = { id: q.id, answer: q.answer, type: q.type };
    });
    When('"Alex" POSTs the WRONG answer to /api/kid/logic/answer', async () => {
      const wrongAnswer = !currentQuestion.answer; // flip boolean
      answerRes = await app.request('/api/kid/logic/answer', {
        method: 'POST',
        headers: jsonAuth('Alex'),
        body: JSON.stringify({
          gameType: 'truefalse',
          difficulty: 'easy',
          questionId: currentQuestion.id,
          answer: wrongAnswer,
        }),
      });
      answerBody = (await answerRes.json()) as typeof answerBody;
    });
    Then('the logic answer response status is 200', () => expect(answerRes.status).toBe(200));
    And('the logic answer body has correct false', () => expect(answerBody.correct).toBe(false));
    And('the logic answer body has comboCorrect 0', () => expect(answerBody.comboCorrect).toBe(0));
  });

  // ─── Certificate awarded at 10 correct ───────────────────────────────────────

  Scenario(
    'certificate awarded at 10 correct answers for the same combo',
    ({ Given, When, Then, And }) => {
      Given('"Alex" answers 9 truefalse easy questions correctly', async () => {
        const qs = getRawQuestions('truefalse', 'easy');
        for (let i = 0; i < 9; i++) {
          const q = qs[i % qs.length]!;
          await app.request('/api/kid/logic/answer', {
            method: 'POST',
            headers: jsonAuth('Alex'),
            body: JSON.stringify({
              gameType: 'truefalse',
              difficulty: 'easy',
              questionId: q.id,
              answer: q.answer,
            }),
          });
        }
        // Store the 10th question for the next step.
        const tenthQ = qs[9 % qs.length]!;
        currentQuestion = { id: tenthQ.id, answer: tenthQ.answer, type: tenthQ.type };
      });
      When('"Alex" POSTs the correct answer to the 10th truefalse easy question', async () => {
        answerRes = await app.request('/api/kid/logic/answer', {
          method: 'POST',
          headers: jsonAuth('Alex'),
          body: JSON.stringify({
            gameType: 'truefalse',
            difficulty: 'easy',
            questionId: currentQuestion.id,
            answer: currentQuestion.answer,
          }),
        });
        answerBody = (await answerRes.json()) as typeof answerBody;
      });
      Then('the logic answer response status is 200', () => expect(answerRes.status).toBe(200));
      And('the logic answer body has certificateEarned true', () =>
        expect(answerBody.certificateEarned).toBe(true),
      );
      When('"Alex" GETs /api/kid/logic/certificates', async () => {
        certsGetRes = await app.request('/api/kid/logic/certificates', {
          headers: authFor('Alex'),
        });
        certsBody = (await certsGetRes.json()) as typeof certsBody;
      });
      Then(
        'the logic certificates list contains a cert for gameType "truefalse" difficulty "easy"',
        () => {
          const found = certsBody.certificates.some(
            (c) => c['gameType'] === 'truefalse' && c['difficulty'] === 'easy',
          );
          expect(found).toBe(true);
        },
      );
    },
  );

  // ─── Certificate idempotency ──────────────────────────────────────────────────

  Scenario('certificate award is idempotent for the same combo', ({ Given, When, Then }) => {
    Given('"Alex" answers 10 truefalse easy questions correctly', async () => {
      const qs = getRawQuestions('truefalse', 'easy');
      for (let i = 0; i < 10; i++) {
        const q = qs[i % qs.length]!;
        await app.request('/api/kid/logic/answer', {
          method: 'POST',
          headers: jsonAuth('Alex'),
          body: JSON.stringify({
            gameType: 'truefalse',
            difficulty: 'easy',
            questionId: q.id,
            answer: q.answer,
          }),
        });
      }
      const q11 = qs[10 % qs.length]!;
      currentQuestion = { id: q11.id, answer: q11.answer, type: q11.type };
    });
    When('"Alex" answers 1 more truefalse easy question correctly', async () => {
      await app.request('/api/kid/logic/answer', {
        method: 'POST',
        headers: jsonAuth('Alex'),
        body: JSON.stringify({
          gameType: 'truefalse',
          difficulty: 'easy',
          questionId: currentQuestion.id,
          answer: currentQuestion.answer,
        }),
      });
      certsGetRes = await app.request('/api/kid/logic/certificates', {
        headers: authFor('Alex'),
      });
      certsBody = (await certsGetRes.json()) as typeof certsBody;
    });
    Then(
      'the logic certificates list has exactly 1 cert for gameType "truefalse" difficulty "easy"',
      () => {
        const matches = certsBody.certificates.filter(
          (c) => c['gameType'] === 'truefalse' && c['difficulty'] === 'easy',
        );
        expect(matches).toHaveLength(1);
      },
    );
  });

  // ─── GET /api/kid/logic/certificates: empty initially ───────────────────────

  Scenario(
    'GET /api/kid/logic/certificates returns empty array initially',
    ({ When, Then, And }) => {
      When('"Alex" GETs /api/kid/logic/certificates', async () => {
        certsGetRes = await app.request('/api/kid/logic/certificates', {
          headers: authFor('Alex'),
        });
        certsBody = (await certsGetRes.json()) as typeof certsBody;
      });
      Then('the logic certificates response status is 200', () =>
        expect(certsGetRes.status).toBe(200),
      );
      And('the logic certificates list is empty', () =>
        expect(certsBody.certificates).toHaveLength(0),
      );
    },
  );

  // ─── 400 on unknown questionId ────────────────────────────────────────────────

  Scenario('400 when questionId is unknown', ({ When, Then }) => {
    When('"Alex" POSTs /api/kid/logic/answer with unknown questionId', async () => {
      answerRes = await app.request('/api/kid/logic/answer', {
        method: 'POST',
        headers: jsonAuth('Alex'),
        body: JSON.stringify({
          gameType: 'truefalse',
          difficulty: 'easy',
          questionId: 'does-not-exist-999',
          answer: true,
        }),
      });
    });
    Then('the logic answer response status is 400', () => expect(answerRes.status).toBe(400));
  });

  // ─── Tenant isolation: Sam sees none of Alex's certs ────────────────────────

  Scenario(
    "tenant isolation: Sam sees none of Alex's progress or certs",
    ({ Given, When, Then, And }) => {
      Given('"Alex" answers 10 truefalse easy questions correctly', async () => {
        const qs = getRawQuestions('truefalse', 'easy');
        for (let i = 0; i < 10; i++) {
          const q = qs[i % qs.length]!;
          await app.request('/api/kid/logic/answer', {
            method: 'POST',
            headers: jsonAuth('Alex'),
            body: JSON.stringify({
              gameType: 'truefalse',
              difficulty: 'easy',
              questionId: q.id,
              answer: q.answer,
            }),
          });
        }
      });
      When('"Sam" GETs /api/kid/logic/certificates', async () => {
        certsGetRes = await app.request('/api/kid/logic/certificates', {
          headers: authFor('Sam'),
        });
        certsBody = (await certsGetRes.json()) as typeof certsBody;
      });
      Then('the logic certificates response status is 200', () =>
        expect(certsGetRes.status).toBe(200),
      );
      And('the logic certificates list is empty', () =>
        expect(certsBody.certificates).toHaveLength(0),
      );
    },
  );

  // ─── Same-tenant member isolation ────────────────────────────────────────────
  // Feature keywords: Given / And / When / Then. Must match exactly.

  Scenario(
    "same-tenant member isolation: a sibling sees none of Alex's certs",
    ({ Given, And, When, Then }) => {
      Given('a logic sibling "Jordan" in the same tenant as Alex', async () => {
        const allTenants = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenants);
        // The first tenant is "logic-fam" (Alex's tenant, created in Background).
        const alexTenant = allTenants[0]!;
        const [jordan] = await db
          .insert(members)
          .values({ tenantId: alexTenant.id, displayName: 'Jordan', role: 'child', isChild: true })
          .returning();
        tokens.set('Jordan', await mintKidToken(jordan!.id, alexTenant.id, alexTenant.slug));
      });
      // Feature line 69 uses "And" keyword: must bind with And(), not Given().
      And('"Alex" answers 10 truefalse easy questions correctly', async () => {
        const qs = getRawQuestions('truefalse', 'easy');
        for (let i = 0; i < 10; i++) {
          const q = qs[i % qs.length]!;
          await app.request('/api/kid/logic/answer', {
            method: 'POST',
            headers: jsonAuth('Alex'),
            body: JSON.stringify({
              gameType: 'truefalse',
              difficulty: 'easy',
              questionId: q.id,
              answer: q.answer,
            }),
          });
        }
      });
      When('"Jordan" GETs /api/kid/logic/certificates', async () => {
        certsGetRes = await app.request('/api/kid/logic/certificates', {
          headers: authFor('Jordan'),
        });
        certsBody = (await certsGetRes.json()) as typeof certsBody;
      });
      Then('the logic certificates list is empty', () =>
        expect(certsBody.certificates).toHaveLength(0),
      );
    },
  );

  // ─── Scenario #6: wrong x9 then correct x1 → comboCorrect 1 ─────────────────

  Scenario('wrong x9 then correct x1 gives comboCorrect 1 not 10', ({ Given, When, Then }) => {
    Given('"Alex" submits 9 wrong truefalse easy answers', async () => {
      const qs = getRawQuestions('truefalse', 'easy');
      for (let i = 0; i < 9; i++) {
        const q = qs[i % qs.length]!;
        const wrongAnswer = !q.answer; // flip boolean
        await app.request('/api/kid/logic/answer', {
          method: 'POST',
          headers: jsonAuth('Alex'),
          body: JSON.stringify({
            gameType: 'truefalse',
            difficulty: 'easy',
            questionId: q.id,
            answer: wrongAnswer,
          }),
        });
      }
      const q10 = qs[9 % qs.length]!;
      currentQuestion = { id: q10.id, answer: q10.answer, type: q10.type };
    });
    When('"Alex" then submits 1 correct truefalse easy answer', async () => {
      answerRes = await app.request('/api/kid/logic/answer', {
        method: 'POST',
        headers: jsonAuth('Alex'),
        body: JSON.stringify({
          gameType: 'truefalse',
          difficulty: 'easy',
          questionId: currentQuestion.id,
          answer: currentQuestion.answer,
        }),
      });
      answerBody = (await answerRes.json()) as typeof answerBody;
    });
    Then('comboCorrect is 1 and certificateEarned is false', () => {
      expect(answerBody.correct).toBe(true);
      expect(answerBody.comboCorrect).toBe(1);
      expect(answerBody.certificateEarned).toBe(false);
    });
  });
});
