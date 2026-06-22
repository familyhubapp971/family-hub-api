/**
 * Step bindings for kid-learn.feature (FHS-367).
 *
 * The kid does lessons + keeps a reading log, scoped to themselves. Real kid
 * token against real Postgres.
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
import type { Database } from '../../../apps/api/src/db/client.js';

const KID_ISSUER = 'family-hub-kid-auth';

let db: Database;
let app: Hono;
const tokens = new Map<string, string>();
let res: Response;
let addRes: Response;
let answerRes: Response;
let siblingRes: Response;

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
});
