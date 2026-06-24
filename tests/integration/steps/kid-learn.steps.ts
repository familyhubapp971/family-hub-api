/**
 * Step bindings for kid-learn.feature (FHS-367 / FHS-382).
 *
 * The kid does lessons + keeps a reading log, scoped to themselves. Real kid
 * token against real Postgres.
 *
 * GAP 5 — answer-grading state machine: streak reset, best-streak retention,
 *          certificate award when CERTIFICATE_TARGET correct answers reached.
 * GAP 6 — cross-TENANT isolation: a kid from family B cannot affect family A.
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
import { CERTIFICATE_TARGET } from '../../../apps/api/src/lib/learn-questions.js';
import type { Database } from '../../../apps/api/src/db/client.js';

const KID_ISSUER = 'family-hub-kid-auth';

// ─── Maths easy bank (correct answer index = 1 for all three) ─────────────────
// maths-e1: answerIndex 1, maths-e2: answerIndex 1, maths-e3: answerIndex 2
// We cycle through all easy questions to reach CERTIFICATE_TARGET.
const MATHS_EASY_QUESTIONS: Array<{ id: string; correctIndex: number; wrongIndex: number }> = [
  { id: 'maths-e1', correctIndex: 1, wrongIndex: 0 },
  { id: 'maths-e2', correctIndex: 1, wrongIndex: 0 },
  { id: 'maths-e3', correctIndex: 2, wrongIndex: 0 },
  { id: 'maths-m1', correctIndex: 1, wrongIndex: 0 },
  { id: 'maths-m2', correctIndex: 1, wrongIndex: 0 },
  { id: 'maths-m3', correctIndex: 1, wrongIndex: 0 },
  { id: 'maths-h1', correctIndex: 1, wrongIndex: 0 },
  { id: 'maths-h2', correctIndex: 2, wrongIndex: 0 },
  { id: 'maths-h3', correctIndex: 0, wrongIndex: 1 },
];

let db: Database;
let app: Hono;
const tokens = new Map<string, string>();
let res: Response;
let addRes: Response;
let answerRes: Response;
let siblingRes: Response;
let subtopicRes: Response;
// GAP 5 — state machine tracking
let streakRes: Response;
let certRes: Response;

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
  new URL('../features/kid-learn.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    Given('a family with kid "Iman" and sibling "Yusuf"', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      const [t] = await db
        .insert(tenants)
        .values({ slug: `kidlearn-${randomUUID().slice(0, 8)}`, name: 'Learn Fam' })
        .returning();
      const [iman] = await db
        .insert(members)
        .values({ tenantId: t!.id, displayName: 'Iman', role: 'child', isChild: true })
        .returning();
      const [yusuf] = await db
        .insert(members)
        .values({ tenantId: t!.id, displayName: 'Yusuf', role: 'child', isChild: true })
        .returning();
      tokens.set('Iman', await mintKidToken(iman!.id, t!.id, t!.slug));
      tokens.set('Yusuf', await mintKidToken(yusuf!.id, t!.id, t!.slug));
      app = new Hono();
      app.route('/api/kid', kidRouter);
    });
  });

  Scenario('a kid sees their lesson subjects', ({ When, Then, And }) => {
    let names: string[] = [];
    When('the kid "Iman" GETs /api/kid/learn', async () => {
      res = await app.request('/api/kid/learn', { headers: authFor('Iman') });
      const b = (await res.json()) as { subjects: Array<{ subject: string }> };
      names = b.subjects.map((s) => s.subject);
    });
    Then('the kid learn response status is 200', () => expect(res.status).toBe(200));
    And('the kid learn subjects include "Maths"', () => expect(names).toContain('Maths'));
    And('the kid learn subjects include "Logic"', () => expect(names).toContain('Logic'));
  });

  Scenario('a kid answers a lesson question', ({ When, Then, And }) => {
    When('the kid "Iman" answers a Maths question', async () => {
      const q = await app.request('/api/kid/learn/Maths/questions?difficulty=easy', {
        headers: authFor('Iman'),
      });
      const body = (await q.json()) as { questions: Array<{ id: string }> };
      answerRes = await app.request('/api/kid/learn/Maths/answer', {
        method: 'POST',
        headers: jsonAuth('Iman'),
        body: JSON.stringify({ questionId: body.questions[0]!.id, choiceIndex: 0 }),
      });
    });
    Then('the answer response status is 200', () => expect(answerRes.status).toBe(200));
    And('the kid Maths answered count is 1', async () => {
      const q = await app.request('/api/kid/learn/Maths/questions?difficulty=easy', {
        headers: authFor('Iman'),
      });
      const body = (await q.json()) as { stats: { answered: number } };
      expect(body.stats.answered).toBe(1);
    });
  });

  Scenario('a kid keeps a reading log, scoped to themselves', ({ When, Then, And }) => {
    When('the kid "Iman" adds the book "Matilda"', async () => {
      addRes = await app.request('/api/kid/reading-log', {
        method: 'POST',
        headers: jsonAuth('Iman'),
        body: JSON.stringify({ title: 'Matilda' }),
      });
    });
    Then('the add-book response status is 201', () => expect(addRes.status).toBe(201));
    And('reading "Iman" books includes "Matilda"', async () => {
      const r = await app.request('/api/kid/reading-log', { headers: authFor('Iman') });
      const b = (await r.json()) as { books: Array<{ title: string }> };
      expect(b.books.map((x) => x.title)).toContain('Matilda');
    });
    And('reading "Yusuf" books is empty', async () => {
      const r = await app.request('/api/kid/reading-log', { headers: authFor('Yusuf') });
      const b = (await r.json()) as { books: unknown[] };
      expect(b.books).toHaveLength(0);
    });
  });

  Scenario('a kid explores Logic sub-topics', ({ When, Then, And }) => {
    let subtopicBody: { questions: Array<{ subtopic?: string }> };
    When('the kid "Iman" fetches Logic questions filtered by subtopic "patterns"', async () => {
      subtopicRes = await app.request(
        '/api/kid/learn/Logic/questions?difficulty=easy&subtopic=patterns',
        { headers: authFor('Iman') },
      );
      subtopicBody = (await subtopicRes.json()) as typeof subtopicBody;
    });
    Then('the subtopic questions response status is 200', () =>
      expect(subtopicRes.status).toBe(200),
    );
    And('all returned questions have subtopic "patterns"', () => {
      expect(subtopicBody.questions.length).toBeGreaterThan(0);
      for (const q of subtopicBody.questions) {
        expect(q.subtopic).toBe('patterns');
      }
    });
  });

  Scenario("a kid cannot change a sibling's book", ({ When, Then }) => {
    When('"Yusuf" tries to mark "Iman"\'s book finished', async () => {
      const add = await app.request('/api/kid/reading-log', {
        method: 'POST',
        headers: jsonAuth('Iman'),
        body: JSON.stringify({ title: 'Matilda' }),
      });
      const book = (await add.json()) as { id: string };
      siblingRes = await app.request(`/api/kid/reading-log/${book.id}`, {
        method: 'PATCH',
        headers: jsonAuth('Yusuf'),
        body: JSON.stringify({ finished: true }),
      });
    });
    Then('the sibling change response status is 404', () => {
      expect(siblingRes.status).toBe(404);
    });
  });

  // ─── GAP 5: answer-grading state machine ─────────────────────────────────────

  Scenario('a wrong answer resets the streak to 0', ({ When, And, Then }) => {
    let statsAfterWrong: { streak: number } | undefined;

    When('the kid "Iman" answers a Maths question correctly', async () => {
      const q = MATHS_EASY_QUESTIONS[0]!;
      streakRes = await app.request('/api/kid/learn/Maths/answer', {
        method: 'POST',
        headers: jsonAuth('Iman'),
        body: JSON.stringify({ questionId: q.id, choiceIndex: q.correctIndex }),
      });
    });
    And('the kid "Iman" answers a Maths question incorrectly', async () => {
      const q = MATHS_EASY_QUESTIONS[0]!;
      streakRes = await app.request('/api/kid/learn/Maths/answer', {
        method: 'POST',
        headers: jsonAuth('Iman'),
        body: JSON.stringify({ questionId: q.id, choiceIndex: q.wrongIndex }),
      });
      const body = (await streakRes.json()) as { stats: { streak: number } };
      statsAfterWrong = body.stats;
    });
    Then('the Maths current streak is 0', () => {
      expect(statsAfterWrong?.streak).toBe(0);
    });
  });

  Scenario('the best streak is retained after a wrong answer', ({ When, And, Then }) => {
    let statsBest: { best: number } | undefined;

    When('the kid "Iman" answers a Maths question correctly', async () => {
      const q = MATHS_EASY_QUESTIONS[0]!;
      await app.request('/api/kid/learn/Maths/answer', {
        method: 'POST',
        headers: jsonAuth('Iman'),
        body: JSON.stringify({ questionId: q.id, choiceIndex: q.correctIndex }),
      });
    });
    And('the kid "Iman" answers a Maths question incorrectly', async () => {
      const q = MATHS_EASY_QUESTIONS[0]!;
      const r = await app.request('/api/kid/learn/Maths/answer', {
        method: 'POST',
        headers: jsonAuth('Iman'),
        body: JSON.stringify({ questionId: q.id, choiceIndex: q.wrongIndex }),
      });
      const body = (await r.json()) as { stats: { best: number } };
      statsBest = body.stats;
    });
    Then('the Maths best streak is at least 1', () => {
      expect(statsBest?.best).toBeGreaterThanOrEqual(1);
    });
  });

  Scenario('reaching the certificate target awards a certificate', ({ When, Then }) => {
    let certStats: { certificate: boolean } | undefined;

    When(
      'the kid "Iman" answers enough Maths questions correctly to reach the target',
      async () => {
        // Answer CERTIFICATE_TARGET questions correctly, cycling the bank as needed.
        for (let i = 0; i < CERTIFICATE_TARGET; i++) {
          const q = MATHS_EASY_QUESTIONS[i % MATHS_EASY_QUESTIONS.length]!;
          const r = await app.request('/api/kid/learn/Maths/answer', {
            method: 'POST',
            headers: jsonAuth('Iman'),
            body: JSON.stringify({ questionId: q.id, choiceIndex: q.correctIndex }),
          });
          certRes = r;
        }
        const body = (await certRes.json()) as { stats: { certificate: boolean } };
        certStats = body.stats;
      },
    );
    Then('the Maths answer response has certificate true', () => {
      expect(certStats?.certificate).toBe(true);
    });
  });

  // ─── GAP 6: cross-TENANT isolation ───────────────────────────────────────────

  Scenario(
    "a kid from family B cannot affect a lesson for family A's child",
    ({ Given, When, Then }) => {
      let omarToken: string;
      let imanProgressBefore: number;
      let imanProgressAfter: number;
      let crossTenantRes: Response;

      Given('a second family with kid "Omar"', async () => {
        // Family B is a completely separate tenant — different slug, no shared data.
        const [t2] = await db
          .insert(tenants)
          .values({ slug: `kidlearn-b-${randomUUID().slice(0, 8)}`, name: 'Omar Fam' })
          .returning();
        const [omar] = await db
          .insert(members)
          .values({ tenantId: t2!.id, displayName: 'Omar', role: 'child', isChild: true })
          .returning();
        omarToken = await mintKidToken(omar!.id, t2!.id, t2!.slug);
      });

      When('"Omar" POSTs a Maths answer using "Iman"\'s subject path', async () => {
        // First capture Iman's current Maths progress.
        const before = await app.request('/api/kid/learn/Maths/questions?difficulty=easy', {
          headers: authFor('Iman'),
        });
        const beforeBody = (await before.json()) as { stats: { answered: number } };
        imanProgressBefore = beforeBody.stats.answered;

        // Omar uses his own (family B) kid token but targets the same /api/kid route.
        // The route scopes entirely from the token — the subject path 'Maths' is
        // shared, but the learnProgress row is keyed by (tenantId, memberId, subject).
        const q = MATHS_EASY_QUESTIONS[0]!;
        crossTenantRes = await app.request('/api/kid/learn/Maths/answer', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${omarToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ questionId: q.id, choiceIndex: q.correctIndex }),
        });
      });

      Then(
        'the cross-tenant answer response does not affect "Iman"\'s Maths progress',
        async () => {
          // Omar's own answer should succeed (200) — he's a valid kid in his own tenant.
          expect(crossTenantRes.status).toBe(200);

          // Iman's answered count must be unchanged.
          const after = await app.request('/api/kid/learn/Maths/questions?difficulty=easy', {
            headers: authFor('Iman'),
          });
          const afterBody = (await after.json()) as { stats: { answered: number } };
          imanProgressAfter = afterBody.stats.answered;
          expect(imanProgressAfter).toBe(imanProgressBefore);
        },
      );
    },
  );
});
