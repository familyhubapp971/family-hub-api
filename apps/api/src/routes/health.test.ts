import { describe, it, expect } from 'vitest';
import { buildApp } from '../app.js';
import { healthResponseSchema } from './health.js';

describe('GET /health', () => {
  it('returns 200 with status, version, uptime', async () => {
    const app = buildApp();
    const res = await app.request('/health');

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = healthResponseSchema.parse(body);

    expect(parsed.status).toBe('ok');
    expect(typeof parsed.version).toBe('string');
    expect(parsed.uptime).toBeGreaterThanOrEqual(0);
  });
});
