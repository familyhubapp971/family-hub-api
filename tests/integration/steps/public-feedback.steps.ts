import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import { sql, eq } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { publicFeedbackRouter } from '../../../apps/api/src/routes/public-feedback.js';
import { publicFeedback } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({ getDb: () => getTestDb() }));

const feature = await loadFeature(
  new URL('../features/public-feedback.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;

  // Shared across scenarios in the same run.
  let lastRes: Response;
  let lastBody: unknown;

  Background(({ Given }) => {
    Given('the public_feedback table is clean', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE public_feedback RESTART IDENTITY CASCADE`);
      app = new Hono();
      app.route('/api/public/feedback', publicFeedbackRouter);
    });
  });

  Scenario('POST with survey answers returns 201 and persists the row', ({ When, Then, And }) => {
    When(
      'an anonymous visitor POSTs public feedback with pmfDisappointment {string} and painPoint {string}',
      async (_ctx, pmf: string, pain: string) => {
        lastRes = await app.request('/api/public/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pmfDisappointment: pmf, painPoint: pain }),
        });
        lastBody = await lastRes.json();
      },
    );

    Then('the public feedback POST status is 201', () => {
      expect(lastRes.status).toBe(201);
    });

    And('the public feedback response contains a valid id', () => {
      const body = lastBody as { success: boolean; id: string };
      expect(body.success).toBe(true);
      expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    And(
      'a public_feedback row exists with pmf_disappointment {string}',
      async (_ctx, pmf: string) => {
        const rows = await db
          .select()
          .from(publicFeedback)
          .where(eq(publicFeedback.pmfDisappointment, pmf));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.source).toBe('public');
      },
    );
  });

  Scenario('POST with only name and email returns 400', ({ When, Then }) => {
    When(
      'an anonymous visitor POSTs public feedback with only name {string} and email {string}',
      async (_ctx, name: string, email: string) => {
        lastRes = await app.request('/api/public/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email }),
        });
        lastBody = await lastRes.json();
      },
    );

    Then('the public feedback POST status is 400', () => {
      expect(lastRes.status).toBe(400);
    });
  });

  Scenario('POST with junk types returns 400', ({ When, Then }) => {
    When('an anonymous visitor POSTs public feedback with invalid body', async () => {
      lastRes = await app.request('/api/public/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // recommendScore must be int 0-10; 999 is out of range.
        body: JSON.stringify({ recommendScore: 999 }),
      });
      lastBody = await lastRes.json();
    });

    Then('the public feedback POST status is 400', () => {
      expect(lastRes.status).toBe(400);
    });
  });

  Scenario('POST with a survey answer but a malformed email returns 400', ({ When, Then }) => {
    When(
      'an anonymous visitor POSTs public feedback with pmfDisappointment {string} and a malformed email {string}',
      async (_ctx, pmf: string, email: string) => {
        lastRes = await app.request('/api/public/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pmfDisappointment: pmf, email }),
        });
        lastBody = await lastRes.json();
      },
    );

    Then('the public feedback POST status is 400', () => {
      expect(lastRes.status).toBe(400);
    });
  });
});
