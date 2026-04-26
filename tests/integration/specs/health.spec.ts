import { describe, it, expect } from 'vitest';
import { getTestDb } from '../support/db.js';
import { app } from '@familyhub/api/app';
import { makeRequest } from '../support/helpers.js';

describe('integration: GET /health', () => {
  it('returns 200 with status/version/uptime', async () => {
    const res = await makeRequest(app, 'GET', '/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string; uptime: number };
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('test Postgres is reachable on port 5433', async () => {
    const db = getTestDb();
    const result = (await db.execute('SELECT 1 AS one')) as unknown as {
      rows: Array<{ one: number }>;
    };
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.one).toBe(1);
  });
});
