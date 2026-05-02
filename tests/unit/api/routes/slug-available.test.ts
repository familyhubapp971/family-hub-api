import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { slugAvailableRouter } from '../../../../apps/api/src/routes/slug-available.js';

const dbMock = { select: vi.fn() };
vi.mock('../../../../apps/api/src/db/client.js', () => ({
  getDb: () => dbMock,
}));

beforeEach(() => {
  dbMock.select.mockReset();
});

function buildApp() {
  // No auth middleware — slug-available is in PUBLIC_PATH_PREFIXES so
  // we test the bare router. Production wiring still mounts auth, which
  // checks the prefix list and skips this path.
  const app = new Hono();
  app.route('/api/public/slug-available', slugAvailableRouter);
  return app;
}

describe('FHS-27 — GET /api/public/slug-available', () => {
  it('returns 400 when slug query param is missing', async () => {
    const res = await buildApp().request('/api/public/slug-available');
    expect(res.status).toBe(400);
  });

  it('returns 400 when slug fails the regex (uppercase)', async () => {
    const res = await buildApp().request('/api/public/slug-available?slug=BadSlug');
    expect(res.status).toBe(400);
  });

  it('returns available=true with empty suggestions when the slug is free', async () => {
    dbMock.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    });
    const res = await buildApp().request('/api/public/slug-available?slug=khan');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; available: boolean; suggestions: string[] };
    expect(body).toEqual({ slug: 'khan', available: true, suggestions: [] });
  });

  it('returns available=false with three suggestions when the slug is taken', async () => {
    dbMock.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'existing' }]) }) }),
    });
    const res = await buildApp().request('/api/public/slug-available?slug=khan');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; available: boolean; suggestions: string[] };
    expect(body.available).toBe(false);
    expect(body.suggestions).toEqual(['khan42', 'khan-family', 'khan-home']);
  });

  it('caps suggestions at 30 chars to match the schema limit', async () => {
    dbMock.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'x' }]) }) }),
    });
    // 25-char slug → "-family" suffix would be 32 chars; expect truncation.
    const long = 'a'.repeat(25);
    const res = await buildApp().request(`/api/public/slug-available?slug=${long}`);
    const body = (await res.json()) as { suggestions: string[] };
    for (const s of body.suggestions) {
      expect(s.length).toBeLessThanOrEqual(30);
    }
  });
});
