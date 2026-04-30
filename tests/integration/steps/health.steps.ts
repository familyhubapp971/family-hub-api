import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import { app } from '@familyhub/api/app';
import { getTestDb } from '../support/db.js';
import { makeRequest } from '../support/helpers.js';

const feature = await loadFeature(new URL('../features/health.feature', import.meta.url).pathname);

describeFeature(feature, ({ Scenario }) => {
  // Per-scenario state. Re-initialised by re-declaring inside each
  // Scenario via the `let` closure trick: each Scenario gets its own
  // function scope, so `last` is independent across scenarios.

  Scenario('GET /health returns the standard envelope', ({ When, Then, And }) => {
    let status: number;
    let body: { status: string; version: string; uptime: number };

    When('I GET /health', async () => {
      const res = await makeRequest(app, 'GET', '/health');
      status = res.status;
      body = (await res.json()) as typeof body;
    });

    Then('the response status is 200', () => {
      expect(status).toBe(200);
    });

    And('the body field "status" equals "ok"', () => {
      expect(body.status).toBe('ok');
    });

    And('the body field "version" is a string', () => {
      expect(typeof body.version).toBe('string');
    });

    And('the body field "uptime" is a non-negative number', () => {
      expect(typeof body.uptime).toBe('number');
      expect(body.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  Scenario('Test Postgres is reachable on port 5433', ({ When, Then }) => {
    let rows: Array<{ one: number }>;

    When('I run "SELECT 1 AS one" against the test DB', async () => {
      const db = getTestDb();
      const result = (await db.execute('SELECT 1 AS one')) as unknown as {
        rows: Array<{ one: number }>;
      };
      rows = result.rows;
    });

    Then('I get back one row with one equal to 1', () => {
      expect(rows).toHaveLength(1);
      expect(rows[0]?.one).toBe(1);
    });
  });

  Scenario('Unknown routes still require auth — 401, not 404', ({ When, Then, And }) => {
    // The api auth-gates everything except /health and /hello. So an
    // unknown route hits the gate first and returns 401 — the notFound
    // handler is never reached. This is intentional: we don't want to
    // leak which routes exist by returning a different code for valid
    // vs invalid paths under the gate.
    let status: number;
    let body: { error: string };

    When('I GET /this-route-does-not-exist', async () => {
      const res = await makeRequest(app, 'GET', '/this-route-does-not-exist');
      status = res.status;
      body = (await res.json()) as typeof body;
    });

    Then('the response status is 401', () => {
      expect(status).toBe(401);
    });

    And('the body equals { "error": "unauthorized" }', () => {
      expect(body).toEqual({ error: 'unauthorized' });
    });
  });

  Scenario('/health survives a concurrent burst — 50 calls all 200', ({ When, Then, And }) => {
    let statuses: number[];

    When('I GET /health 50 times concurrently', async () => {
      const results = await Promise.all(
        Array.from({ length: 50 }, () => makeRequest(app, 'GET', '/health')),
      );
      statuses = results.map((r) => r.status);
    });

    Then('every response status is 200', () => {
      expect(statuses.every((s) => s === 200)).toBe(true);
    });

    And('the test Postgres is still reachable', async () => {
      const db = getTestDb();
      const result = (await db.execute('SELECT 1 AS one')) as unknown as {
        rows: Array<{ one: number }>;
      };
      expect(result.rows[0]?.one).toBe(1);
    });
  });
});
