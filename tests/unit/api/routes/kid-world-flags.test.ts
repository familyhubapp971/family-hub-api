// FHS-373: unit tests for the kid world-flags endpoints.
//
// /api/kid/world-flags        GET  → { explored: string[] }
// /api/kid/world-flags/explore POST → { explored: true }
// /api/kid/world-flags/learn   GET  → { progress: Record<continent, number[]> }
// /api/kid/world-flags/learn-complete POST → { completed: true }
//
// Auth/body-rejection paths use the real app (buildApp) with a valid kid
// token: no DB needed. Happy paths use the kidRouter directly with a
// mocked DB, matching the pattern in world-flags.test.ts.

import { SignJWT } from 'jose';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../../../apps/api/src/config.js';
import { KID_ISSUER } from '../../../../apps/api/src/middleware/kid-auth.js';

// ─── DB mock (scoped to this module) ─────────────────────────────────────────

const dbMock = {
  select: vi.fn(),
  insert: vi.fn(),
};

vi.mock('../../../../apps/api/src/db/client.js', () => ({
  getDb: () => dbMock,
  pinRequestTenant: async () => {},
}));

// Import after mock so kidRouter picks up the mocked getDb.
const { kidRouter } = await import('../../../../apps/api/src/routes/kid.js');

// ─── Token helpers ────────────────────────────────────────────────────────────

const KEY = new TextEncoder().encode(config.KID_AUTH_SECRET);
const MEMBER_ID = '44444444-4444-4444-8444-444444444444';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_SLUG = 'test-fam';

async function mintKidToken(secondsFromNow = 3600): Promise<string> {
  return new SignJWT({ scope: 'child', tenantId: TENANT_ID, tenantSlug: TENANT_SLUG })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(MEMBER_ID)
    .setIssuer(KID_ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + secondsFromNow)
    .sign(KEY);
}

// ─── Local router app (mocked DB, no real Postgres) ──────────────────────────

function buildLocalApp() {
  const app = new Hono();
  app.route('/api/kid', kidRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
});

// ─── Auth: expired token is rejected on every endpoint ───────────────────────

describe('FHS-373: expired kid token is rejected (401)', () => {
  const routes: [string, RequestInit | undefined][] = [
    ['/api/kid/world-flags', undefined],
    [
      '/api/kid/world-flags/explore',
      { method: 'POST', body: JSON.stringify({ countryCode: 'GB' }) },
    ],
    ['/api/kid/world-flags/learn', undefined],
    [
      '/api/kid/world-flags/learn-complete',
      { method: 'POST', body: JSON.stringify({ continent: 'Africa', chunkIndex: 0 }) },
    ],
  ];
  it.each(routes)('401 (not 403) for an expired token on %s', async (path, init) => {
    const token = await mintKidToken(-10); // already expired
    const res = await buildLocalApp().request(path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/kid/world-flags ─────────────────────────────────────────────────

describe('FHS-373: GET /api/kid/world-flags', () => {
  it('403 when no kid token is presented', async () => {
    const res = await buildLocalApp().request('/api/kid/world-flags');
    expect(res.status).toBe(403);
  });

  it('200 and returns empty explored list when kid has no flags', async () => {
    dbMock.select.mockImplementationOnce(() => ({
      from: () => ({ where: () => Promise.resolve([]) }),
    }));
    const token = await mintKidToken();
    const res = await buildLocalApp().request('/api/kid/world-flags', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { explored: string[] };
    expect(body.explored).toHaveLength(0);
  });

  it('200 and returns explored codes when flags exist', async () => {
    dbMock.select.mockImplementationOnce(() => ({
      from: () => ({
        where: () => Promise.resolve([{ countryCode: 'GB' }, { countryCode: 'JP' }]),
      }),
    }));
    const token = await mintKidToken();
    const res = await buildLocalApp().request('/api/kid/world-flags', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { explored: string[] };
    expect(body.explored).toContain('GB');
    expect(body.explored).toContain('JP');
  });
});

// ─── POST /api/kid/world-flags/explore ───────────────────────────────────────

describe('FHS-373: POST /api/kid/world-flags/explore', () => {
  it('400 when body is missing', async () => {
    const token = await mintKidToken();
    const res = await buildLocalApp().request('/api/kid/world-flags/explore', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid request');
  });

  it('400 when countryCode is too short', async () => {
    const token = await mintKidToken();
    const res = await buildLocalApp().request('/api/kid/world-flags/explore', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ countryCode: 'X' }),
    });
    expect(res.status).toBe(400);
  });

  it('200 and returns { explored: true } on valid body', async () => {
    dbMock.insert.mockImplementationOnce(() => ({
      values: () => ({ onConflictDoNothing: () => Promise.resolve() }),
    }));
    const token = await mintKidToken();
    const res = await buildLocalApp().request('/api/kid/world-flags/explore', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ countryCode: 'GB' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { explored: boolean };
    expect(body.explored).toBe(true);
  });
});

// ─── GET /api/kid/world-flags/learn ──────────────────────────────────────────

describe('FHS-373: GET /api/kid/world-flags/learn', () => {
  it('403 when no kid token is presented', async () => {
    const res = await buildLocalApp().request('/api/kid/world-flags/learn');
    expect(res.status).toBe(403);
  });

  it('200 and returns empty progress when nothing completed', async () => {
    dbMock.select.mockImplementationOnce(() => ({
      from: () => ({ where: () => Promise.resolve([]) }),
    }));
    const token = await mintKidToken();
    const res = await buildLocalApp().request('/api/kid/world-flags/learn', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { progress: Record<string, number[]> };
    expect(Object.keys(body.progress)).toHaveLength(0);
  });

  it('200 and returns continent progress sorted ascending', async () => {
    dbMock.select.mockImplementationOnce(() => ({
      from: () => ({
        where: () =>
          Promise.resolve([
            { continent: 'Africa', chunkIndex: 2 },
            { continent: 'Africa', chunkIndex: 0 },
          ]),
      }),
    }));
    const token = await mintKidToken();
    const res = await buildLocalApp().request('/api/kid/world-flags/learn', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { progress: Record<string, number[]> };
    expect(body.progress['Africa']).toEqual([0, 2]);
  });
});

// ─── POST /api/kid/world-flags/learn-complete ────────────────────────────────

describe('FHS-373: POST /api/kid/world-flags/learn-complete', () => {
  it('400 when body is missing', async () => {
    const token = await mintKidToken();
    const res = await buildLocalApp().request('/api/kid/world-flags/learn-complete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid request');
  });

  it('400 when continent is not a valid enum value', async () => {
    const token = await mintKidToken();
    const res = await buildLocalApp().request('/api/kid/world-flags/learn-complete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ continent: 'Antarctica', chunkIndex: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it('400 when chunkIndex is negative', async () => {
    const token = await mintKidToken();
    const res = await buildLocalApp().request('/api/kid/world-flags/learn-complete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ continent: 'Africa', chunkIndex: -1 }),
    });
    expect(res.status).toBe(400);
  });

  it('400 when chunkIndex is above the max', async () => {
    const token = await mintKidToken();
    const res = await buildLocalApp().request('/api/kid/world-flags/learn-complete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ continent: 'Africa', chunkIndex: 61 }),
    });
    expect(res.status).toBe(400);
  });

  it('200 and returns { completed: true } on valid body', async () => {
    dbMock.insert.mockImplementationOnce(() => ({
      values: () => ({ onConflictDoNothing: () => Promise.resolve() }),
    }));
    const token = await mintKidToken();
    const res = await buildLocalApp().request('/api/kid/world-flags/learn-complete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ continent: 'Africa', chunkIndex: 0 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { completed: boolean };
    expect(body.completed).toBe(true);
  });
});
