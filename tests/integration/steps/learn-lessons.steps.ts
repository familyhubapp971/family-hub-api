/**
 * Step bindings for learn-lessons.feature (FHS-283).
 *
 * Drives the real learnRouter against Postgres: questions never leak answers,
 * grading is server-authoritative, and streak/score/progress/certificate
 * persist per (member, subject).
 */

import { randomUUID } from 'node:crypto';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono, type MiddlewareHandler } from 'hono';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
  pinRequestTenant: async () => {},
}));

import { learnRouter } from '../../../apps/api/src/routes/learn.js';
import { gradeAnswer } from '../../../apps/api/src/lib/learn-questions.js';
import { tenants, members, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';

let db: Database;
let app: Hono;
let childId: string;

interface Q {
  id: string;
  choices: string[];
}
interface Stats {
  progress: number;
  score: number;
  streak: number;
  best: number;
  certificate: boolean;
}

function correctIndex(qid: string): number {
  // The bank is server-side; find the right index via the grader.
  for (let i = 0; i < 8; i++) {
    const g = gradeAnswer('Maths', qid, i);
    if (g?.correct) return i;
  }
  throw new Error(`no correct index for ${qid}`);
}

async function getQuestions(): Promise<{ status: number; questions: Q[]; stats: Stats }> {
  const res = await app.request(`/api/learn/Maths/questions?memberId=${childId}&difficulty=easy`);
  const body = (await res.json()) as { questions: Q[]; stats: Stats };
  return { status: res.status, ...body };
}

async function answer(
  qid: string,
  choiceIndex: number,
): Promise<{ correct: boolean; stats: Stats }> {
  const res = await app.request('/api/learn/Maths/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId: childId, questionId: qid, choiceIndex }),
  });
  return (await res.json()) as { correct: boolean; stats: Stats };
}

async function answerFirstCorrectly(): Promise<{ correct: boolean; stats: Stats }> {
  const { questions } = await getQuestions();
  const q = questions[0]!;
  return answer(q.id, correctIndex(q.id));
}

async function seed(): Promise<void> {
  db = getTestDb() as unknown as Database;
  await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM users`);
  const callerUser = randomUUID();
  await db.insert(users).values({ id: callerUser, email: `adult-${callerUser.slice(0, 8)}@x.com` });
  const [t] = await db
    .insert(tenants)
    .values({ slug: `learnfam-${randomUUID().slice(0, 8)}`, name: 'Learn Fam' })
    .returning();
  await db
    .insert(members)
    .values({ tenantId: t!.id, userId: callerUser, displayName: 'Adult', role: 'adult' });
  const [kid] = await db
    .insert(members)
    .values({ tenantId: t!.id, displayName: 'Kid', role: 'child', isChild: true })
    .returning();
  childId = kid!.id;

  const seedAuth: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: callerUser, email: 'adult@x.com', claims: {} } as never);
    c.set('userRow', {
      id: callerUser,
      email: 'adult@x.com',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    c.set('tenantId', t!.id as never);
    await next();
  };
  app = new Hono();
  app.use('*', seedAuth);
  app.route('/api/learn', learnRouter);
}

const feature = await loadFeature(
  new URL('../features/learn-lessons.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    Given('a family with an adult and a child, and the adult is signed in', seed);
  });

  Scenario('questions load with zeroed stats', ({ When, Then, And }) => {
    let r: Awaited<ReturnType<typeof getQuestions>>;
    When('the adult gets Maths questions for the child', async () => {
      r = await getQuestions();
    });
    Then('the lesson status is 200', () => expect(r.status).toBe(200));
    And('the questions come without answers', () => {
      expect(r.questions.length).toBeGreaterThan(0);
      for (const q of r.questions) expect(q).not.toHaveProperty('answerIndex');
    });
    And("the child's score starts at 0", () => expect(r.stats.score).toBe(0));
  });

  Scenario('a correct answer raises the score and streak', ({ When, Then, And }) => {
    let res: { correct: boolean; stats: Stats };
    When('the child answers a Maths question correctly', async () => {
      res = await answerFirstCorrectly();
    });
    Then('the answer is graded correct', () => expect(res.correct).toBe(true));
    And('the score is 1 and the streak is 1', () => {
      expect(res.stats.score).toBe(1);
      expect(res.stats.streak).toBe(1);
    });
  });

  Scenario('a wrong answer resets the streak', ({ Given, When, Then, And }) => {
    let res: { correct: boolean; stats: Stats };
    Given('the child has answered one Maths question correctly', async () => {
      await answerFirstCorrectly();
    });
    When('the child answers a Maths question wrongly', async () => {
      const { questions } = await getQuestions();
      const q = questions[0]!;
      const wrong = (correctIndex(q.id) + 1) % q.choices.length;
      res = await answer(q.id, wrong);
    });
    Then('the answer is graded wrong', () => expect(res.correct).toBe(false));
    And('the streak is back to 0', () => expect(res.stats.streak).toBe(0));
  });

  Scenario('reaching the target awards a certificate', ({ When, Then }) => {
    let last: { correct: boolean; stats: Stats };
    When('the child answers Maths correctly 10 times', async () => {
      for (let i = 0; i < 10; i++) last = await answerFirstCorrectly();
    });
    Then('progress is 100 and a certificate is earned', () => {
      expect(last.stats.progress).toBe(100);
      expect(last.stats.certificate).toBe(true);
    });
  });

  Scenario('an outsider cannot answer for this family child', ({ Given, When, Then, And }) => {
    let appB: Hono;
    let outsiderRes: Response;
    Given('another family with its own signed-in adult', async () => {
      const outsider = randomUUID();
      await db.insert(users).values({ id: outsider, email: `out-${outsider.slice(0, 8)}@x.com` });
      const [tb] = await db
        .insert(tenants)
        .values({ slug: `otherfam-${randomUUID().slice(0, 8)}`, name: 'Other Fam' })
        .returning();
      await db
        .insert(members)
        .values({ tenantId: tb!.id, userId: outsider, displayName: 'Outsider', role: 'adult' });
      const seedB: MiddlewareHandler = async (c, next) => {
        c.set('user', { id: outsider, email: 'out@x.com', claims: {} } as never);
        c.set('userRow', {
          id: outsider,
          email: 'out@x.com',
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never);
        c.set('tenantId', tb!.id as never);
        await next();
      };
      appB = new Hono();
      appB.use('*', seedB);
      appB.route('/api/learn', learnRouter);
    });
    When('the outsider tries to answer for the first child', async () => {
      const { questions } = await getQuestions();
      const q = questions[0]!;
      outsiderRes = await appB.request('/api/learn/Maths/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memberId: childId,
          questionId: q.id,
          choiceIndex: correctIndex(q.id),
        }),
      });
    });
    Then('the lesson request is rejected', () => {
      expect([403, 404]).toContain(outsiderRes.status);
    });
    And('the first child score is still 0', async () => {
      const { rows } = await db.execute<{ total_correct: number }>(
        sql`select coalesce(total_correct, 0) as total_correct from learn_progress where member_id = ${childId} and subject = 'Maths'`,
      );
      expect(rows[0]?.total_correct ?? 0).toBe(0);
    });
  });
});
