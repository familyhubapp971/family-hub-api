import { describe, expect, it } from 'vitest';
import { buildApp } from '../../../../apps/api/src/app.js';

describe('FHS-167 — request context', () => {
  it('mints a UUID request_id when none provided and echoes via X-Request-Id', async () => {
    const app = buildApp();
    const res = await app.request('/health');
    const id = res.headers.get('x-request-id');

    expect(id).toBeTruthy();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('honours a caller-provided X-Request-Id when within the length cap', async () => {
    const app = buildApp();
    const res = await app.request('/health', { headers: { 'X-Request-Id': 'trace-abc-123' } });

    expect(res.headers.get('x-request-id')).toBe('trace-abc-123');
  });

  it('mints a fresh UUID when caller-provided id exceeds the length cap', async () => {
    const app = buildApp();
    const huge = 'x'.repeat(200);
    const res = await app.request('/health', { headers: { 'X-Request-Id': huge } });

    expect(res.headers.get('x-request-id')).not.toBe(huge);
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
