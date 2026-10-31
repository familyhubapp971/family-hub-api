import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { asRuntimeTenant } from '@familyhub/test-utils';
import {
  _resetFounderLockoutForTests,
  createFounderRouter,
} from '../../../src/areas/admin/founder.js';
import { tenants, betaFeedback, publicFeedback } from '../../../src/database/schema.js';
import type { Database } from '../../../src/database/client.js';
import { getTestDb } from '../support/db.js';

// FHS-672. A made-up passcode for tests; the real one lives only in Railway.
const PASSCODE = '246810';
const SECRETS = { passcode: PASSCODE, secret: 'integration-test-secret-at-least-32-chars' };

vi.mock('../../../src/database/client.js', () => ({ getDb: () => getTestDb() }));

const feature = await loadFeature(
  new URL('../features/founder-feedback.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let res: Response;
  let token = '';
  let seen = 0;

  function signIn(passcode: string, target: Hono = app) {
    return target.request('/api/founder/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode }),
    });
  }

  Background(({ Given, And }) => {
    Given('the founder test DB has feedback from two families and the homepage', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE beta_feedback, public_feedback RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      const [a] = await db
        .insert(tenants)
        .values({ slug: 'founder-a', name: 'A Family' })
        .returning();
      const [b] = await db
        .insert(tenants)
        .values({ slug: 'founder-b', name: 'B Family' })
        .returning();
      await db.insert(betaFeedback).values({
        tenantId: a!.id,
        submittedByEmail: 'a@example.com',
        screen: 'meals',
        features: ['Add meal'],
        easeOfUse: 4,
        createdAt: new Date('2026-10-01T10:00:00Z'),
      });
      await db.insert(betaFeedback).values({
        tenantId: b!.id,
        submittedByEmail: 'b@example.com',
        pmfDisappointment: 'very',
        createdAt: new Date('2026-10-02T10:00:00Z'),
      });
      await db.insert(publicFeedback).values({
        name: 'Visitor',
        otherFeedback: 'Looks great',
        createdAt: new Date('2026-10-03T10:00:00Z'),
      });
      app = new Hono().route(
        '/api/founder',
        createFounderRouter(() => SECRETS),
      );
    });
    And('the founder lockout is reset', () => {
      _resetFounderLockoutForTests();
      token = '';
    });
  });

  Scenario('Founder opens the feedback page', ({ When, Then, And }) => {
    When('the founder signs in with the right passcode', async () => {
      res = await signIn(PASSCODE);
    });
    Then('the sign-in returns a page token', async () => {
      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string; expiresAt: string };
      expect(body.token).toMatch(/^\d+\.[\w-]+$/);
      token = body.token;
    });
    And(
      'the feedback list holds answers from both families and the homepage, newest first',
      async () => {
        const list = await app.request('/api/founder/feedback', {
          headers: { 'x-founder-token': token },
        });
        expect(list.status).toBe(200);
        const { rows } = (await list.json()) as {
          rows: Array<{ source: string; familySlug: string | null; screen: string | null }>;
        };
        expect(rows.map((r) => [r.source, r.familySlug])).toEqual([
          ['public', null],
          ['in_app', 'founder-b'],
          ['screen', 'founder-a'],
        ]);
        expect(rows[2]!.screen).toBe('meals');
      },
    );
  });

  Scenario('Repeated guesses are locked out', ({ When, And, Then }) => {
    When('someone signs in with a wrong passcode {int} times', async (_ctx, n: number) => {
      for (let i = 0; i < n; i++) {
        res = await signIn(`99999${i}`);
        expect(res.status).toBe(401);
      }
    });
    And('the founder signs in with the right passcode', async () => {
      res = await signIn(PASSCODE);
    });
    Then('the founder API answers {int}', (_ctx, status: number) => {
      expect(res.status).toBe(status);
    });
  });

  Scenario('A burst of parallel guesses cannot skip the lockout', ({ When, Then }) => {
    let statuses: number[] = [];
    When('someone fires {int} wrong passcodes at once', async (_ctx, n: number) => {
      const all = await Promise.all(
        Array.from({ length: n }, (_, i) => signIn(String(100000 + i))),
      );
      statuses = all.map((r) => r.status);
    });
    Then('at most {int} of them are checked', (_ctx, max: number) => {
      expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(max);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    });
  });

  Scenario('No token, no feedback', ({ When, Then }) => {
    When('someone asks for the feedback list without a token', async () => {
      res = await app.request('/api/founder/feedback');
    });
    Then('the founder API answers {int}', (_ctx, status: number) => {
      expect(res.status).toBe(status);
    });
  });

  Scenario('Only the founder reader crosses families', ({ When, Then }) => {
    When('the app role with no family pinned reads beta_feedback directly', async () => {
      seen = await asRuntimeTenant(null, async (c) => {
        const r = await c.query('SELECT 1 FROM beta_feedback');
        return r.rows.length;
      });
    });
    Then('it sees {int} rows', (_ctx, n: number) => {
      expect(seen).toBe(n);
    });
    When('the app role with no family pinned calls the founder reader', async () => {
      seen = await asRuntimeTenant(null, async (c) => {
        const r = await c.query('SELECT * FROM app_founder_feedback(100)');
        return r.rows.length;
      });
    });
    Then('it sees all {int} answers', (_ctx, n: number) => {
      expect(seen).toBe(n);
    });
  });
});
