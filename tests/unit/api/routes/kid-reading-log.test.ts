// FHS-382: GAP 4: kid reading-log validation unit tests.
//
// Mirrors the deleted reading-log.test.ts cases against the kid route.
// Uses the real kidRouter with a mocked DB (same pattern as kid-world-flags.test.ts).
// No real Postgres needed: all 400s fire before the DB is touched.

import { SignJWT } from 'jose';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../../../apps/api/src/config.js';
import { KID_ISSUER } from '../../../../apps/api/src/middleware/kid-auth.js';

// ─── DB mock ──────────────────────────────────────────────────────────────────

const dbMock = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

vi.mock('../../../../apps/api/src/db/client.js', () => ({
  getDb: () => dbMock,
  pinRequestTenant: async () => {},
}));

const { kidRouter } = await import('../../../../apps/api/src/routes/kid.js');

// ─── Token helpers ────────────────────────────────────────────────────────────

const KEY = new TextEncoder().encode(config.KID_AUTH_SECRET);
const MEMBER_ID = '55555555-5555-4555-8555-555555555555';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_SLUG = 'read-fam';
const BOOK_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function mintKidToken(secondsFromNow = 3600): Promise<string> {
  return new SignJWT({ scope: 'child', tenantId: TENANT_ID, tenantSlug: TENANT_SLUG })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(MEMBER_ID)
    .setIssuer(KID_ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + secondsFromNow)
    .sign(KEY);
}

function buildLocalApp() {
  const app = new Hono();
  app.route('/api/kid', kidRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
  dbMock.update.mockReset();
  dbMock.delete.mockReset();
});

// ─── POST /api/kid/reading-log: body validation ─────────────────────────────

describe('FHS-382: POST /api/kid/reading-log validation', () => {
  it('400 when title is missing from the body', async () => {
    const token = await mintKidToken();
    const res = await buildLocalApp().request('/api/kid/reading-log', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid request');
  });

  it('400 when title is an empty string', async () => {
    const token = await mintKidToken();
    const res = await buildLocalApp().request('/api/kid/reading-log', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid request');
  });

  it('400 when title exceeds 200 characters', async () => {
    const token = await mintKidToken();
    const res = await buildLocalApp().request('/api/kid/reading-log', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'a'.repeat(201) }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid request');
  });

  it('400 when author exceeds 120 characters', async () => {
    const token = await mintKidToken();
    const res = await buildLocalApp().request('/api/kid/reading-log', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Matilda', author: 'a'.repeat(121) }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid request');
  });
});

// ─── PATCH /api/kid/reading-log/:id: body validation ────────────────────────

describe('FHS-382: PATCH /api/kid/reading-log/:id validation', () => {
  it('400 when finished field is missing', async () => {
    const token = await mintKidToken();
    const res = await buildLocalApp().request(`/api/kid/reading-log/${BOOK_ID}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid request');
  });

  it('400 when finished is not a boolean', async () => {
    const token = await mintKidToken();
    const res = await buildLocalApp().request(`/api/kid/reading-log/${BOOK_ID}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ finished: 'yes' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid request');
  });
});

// ─── DELETE /api/kid/reading-log/:id: id validation ─────────────────────────

describe('FHS-382: DELETE /api/kid/reading-log/:id validation', () => {
  it('400 when id is not a valid UUID', async () => {
    const token = await mintKidToken();
    const res = await buildLocalApp().request('/api/kid/reading-log/not-a-uuid', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid id');
  });

  it('400 when id is a short malformed string', async () => {
    const token = await mintKidToken();
    const res = await buildLocalApp().request('/api/kid/reading-log/12345', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid id');
  });
});
