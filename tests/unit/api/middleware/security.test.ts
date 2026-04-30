import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../../apps/api/src/app.js';
import { _resetRateLimitForTests } from '../../../../apps/api/src/middleware/rate-limit.js';

afterEach(() => {
  _resetRateLimitForTests();
});

describe('FHS-170 — security middleware', () => {
  describe('secure headers (AC #1)', () => {
    it('GET /health response carries the four required headers', async () => {
      const app = buildApp();
      const res = await app.request('/health');

      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('strict-transport-security')).toContain('max-age=31536000');
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    });
  });

  describe('CORS (AC #2)', () => {
    it('blocks unknown origins', async () => {
      const app = buildApp();
      const res = await app.request('/health', {
        method: 'GET',
        headers: { Origin: 'https://evil.example.com' },
      });

      // Hono cors middleware: blocked origins get no Access-Control-Allow-Origin echo.
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('allows localhost in dev', async () => {
      const app = buildApp();
      const res = await app.request('/health', {
        method: 'GET',
        headers: { Origin: 'http://localhost:5173' },
      });

      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    });
  });

  describe('rate limit (AC #3)', () => {
    // /hello is rate-limited (any non-/health route is); /health is
    // exempt so Railway's internal probe can hit it every second
    // without tripping the limiter.
    it('returns 429 after 100 req/min from the same IP', async () => {
      const app = buildApp();
      const headers = { 'X-Forwarded-For': '203.0.113.7' };

      for (let i = 0; i < 100; i += 1) {
        const ok = await app.request('/hello', { headers });
        expect(ok.status, `request ${i + 1} should pass`).toBe(200);
      }

      const blocked = await app.request('/hello', { headers });
      expect(blocked.status).toBe(429);
      const body = (await blocked.json()) as { error: string };
      expect(body.error).toBe('rate limit exceeded');
      expect(blocked.headers.get('retry-after')).toBeTruthy();
      expect(blocked.headers.get('x-ratelimit-remaining')).toBe('0');
    });

    it('isolates buckets per IP', async () => {
      const app = buildApp();
      for (let i = 0; i < 100; i += 1) {
        await app.request('/hello', { headers: { 'X-Forwarded-For': '198.51.100.1' } });
      }
      const bRes = await app.request('/hello', { headers: { 'X-Forwarded-For': '198.51.100.2' } });
      expect(bRes.status).toBe(200);
    });

    it('exempts /health (Railway internal probe has no x-forwarded-for header)', async () => {
      const app = buildApp();
      // Simulate Railway's internal probe: 200 calls with NO IP headers.
      // Without the bypass these would all 429 (or worse, fail-closed
      // with "client identity unavailable" in non-dev).
      for (let i = 0; i < 200; i += 1) {
        const res = await app.request('/health');
        expect(res.status, `health probe ${i + 1} should never be rate-limited`).toBe(200);
      }
    });
  });
});
