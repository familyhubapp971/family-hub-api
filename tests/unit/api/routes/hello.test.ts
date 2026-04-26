import { describe, it, expect } from 'vitest';
import { helloResponseSchema } from '@familyhub/shared';
import { buildApp } from '../../../../apps/api/src/app.js';

describe('GET /hello', () => {
  it('returns 200 with a payload matching the shared Zod schema', async () => {
    const app = buildApp();
    const res = await app.request('/hello');

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = helloResponseSchema.parse(body);

    expect(parsed.message.length).toBeGreaterThan(0);
    expect(() => new Date(parsed.timestamp).toISOString()).not.toThrow();
  });
});
