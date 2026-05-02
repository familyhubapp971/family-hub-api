import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { slugAvailableRouter } from '../../../apps/api/src/routes/slug-available.js';
import { tenants } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(
  new URL('../features/slug-available.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;

  Background(({ Given }) => {
    Given('the test Postgres has a clean tenants table', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      app = new Hono();
      app.route('/api/public/slug-available', slugAvailableRouter);
    });
  });

  Scenario('Free slug returns available=true with no suggestions', ({ When, Then, And }) => {
    let res: Response;
    let body: { available: boolean; suggestions: string[] };

    When('I GET /api/public/slug-available with slug "freshfamily"', async () => {
      res = await app.request('/api/public/slug-available?slug=freshfamily');
      body = (await res.json()) as { available: boolean; suggestions: string[] };
    });

    Then('the response status is 200', () => {
      expect(res.status).toBe(200);
    });

    And('the response body has available=true', () => {
      expect(body.available).toBe(true);
    });

    And('the suggestions list is empty', () => {
      expect(body.suggestions).toEqual([]);
    });
  });

  Scenario(
    'Taken slug returns available=false with three suggestions',
    ({ Given, When, Then, And }) => {
      let res: Response;
      let body: { available: boolean; suggestions: string[] };

      Given('a tenant exists with slug "khan"', async () => {
        await db.insert(tenants).values({ slug: 'khan', name: 'Existing Khan' });
      });

      When('I GET /api/public/slug-available with slug "khan"', async () => {
        res = await app.request('/api/public/slug-available?slug=khan');
        body = (await res.json()) as { available: boolean; suggestions: string[] };
      });

      Then('the response status is 200', () => {
        expect(res.status).toBe(200);
      });

      And('the response body has available=false', () => {
        expect(body.available).toBe(false);
      });

      And('the suggestions list contains "khan42"', () => {
        expect(body.suggestions).toContain('khan42');
      });
    },
  );
});
