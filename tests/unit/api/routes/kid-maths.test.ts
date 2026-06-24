// FHS-394 — unit tests for the kid maths progression endpoints.
//
// Endpoints under test:
//   GET    /api/kid/maths/progress
//   PUT    /api/kid/maths/progress
//   POST   /api/kid/maths/placement
//   GET    /api/kid/maths/certificates
//   POST   /api/kid/maths/certificates
//
// Auth checks: 403 with no token, 401 with an expired token.
// Validation checks: 400 on bad body (PUT/POST).
// Happy paths: correct status + response shape (mocked DB).

import { SignJWT } from 'jose';
import { Hono } from 'hono';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../../../../apps/api/src/config.js';
import { KID_ISSUER } from '../../../../apps/api/src/middleware/kid-auth.js';

// ─── DB mock ──────────────────────────────────────────────────────────────────

const dbMock = {
  select: vi.fn(),
  insert: vi.fn(),
};

vi.mock('../../../../apps/api/src/db/client.js', () => ({
  getDb: () => dbMock,
  pinRequestTenant: async () => {},
}));

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

/** A token with scope:'parent' — getKidAuth should reject it with 403. */
async function mintParentScopeToken(): Promise<string> {
  return new SignJWT({ scope: 'parent', tenantId: TENANT_ID, tenantSlug: TENANT_SLUG })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(MEMBER_ID)
    .setIssuer(KID_ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(KEY);
}

function buildApp() {
  const app = new Hono();
  app.route('/api/kid', kidRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
});

// ─── Auth: no token → 403, expired → 401 ─────────────────────────────────────

describe('FHS-394 — auth guards', () => {
  const endpoints: [string, string, object | undefined][] = [
    ['GET', '/api/kid/maths/progress', undefined],
    ['PUT', '/api/kid/maths/progress', { operation: 'addition', tableNumber: 1 }],
    ['POST', '/api/kid/maths/placement', { operation: 'addition', results: [] }],
    ['GET', '/api/kid/maths/certificates', undefined],
    [
      'POST',
      '/api/kid/maths/certificates',
      { operation: 'addition', difficulty: '1', totalCorrect: 10 },
    ],
  ];

  it.each(endpoints)('%s %s — 403 with no token', async (method, path) => {
    const res = await buildApp().request(path, { method });
    expect(res.status).toBe(403);
  });

  it.each(endpoints)('%s %s — 401 with expired token', async (method, path, body) => {
    const token = await mintKidToken(-10);
    const res = await buildApp().request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/kid/maths/progress ─────────────────────────────────────────────

describe('FHS-394 — GET /api/kid/maths/progress', () => {
  it('200 + empty array when no rows exist', async () => {
    dbMock.select.mockImplementationOnce(() => ({
      from: () => ({ where: () => Promise.resolve([]) }),
    }));
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/maths/progress', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { progress: unknown[] };
    expect(body.progress).toHaveLength(0);
  });

  it('200 + returns rows when progress exists', async () => {
    const row = {
      id: '00000000-0000-4000-8000-000000000001',
      tenantId: TENANT_ID,
      memberId: MEMBER_ID,
      operation: 'addition',
      tableNumber: 3,
      learnCompleted: true,
      practiceCorrect: 10,
      proveScore: 10,
      proveAvgTime: 2.5,
      placementUnlocked: false,
      updatedAt: new Date(),
    };
    // listProgress: select().from().where() — no .limit() in that helper.
    dbMock.select.mockImplementationOnce(() => ({
      from: () => ({ where: () => Promise.resolve([row]) }),
    }));
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/maths/progress', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { progress: Array<{ tableNumber: number }> };
    expect(body.progress).toHaveLength(1);
    expect(body.progress[0]!.tableNumber).toBe(3);
  });
});

// ─── PUT /api/kid/maths/progress ─────────────────────────────────────────────

describe('FHS-394 — PUT /api/kid/maths/progress', () => {
  it('400 when body is empty', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/maths/progress', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('400 when operation is invalid', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/maths/progress', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'modulo', tableNumber: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it('400 when tableNumber is out of range', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/maths/progress', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'addition', tableNumber: 13 }),
    });
    expect(res.status).toBe(400);
  });

  it('200 + updated row on valid body', async () => {
    const upserted = {
      id: '00000000-0000-4000-8000-000000000002',
      tenantId: TENANT_ID,
      memberId: MEMBER_ID,
      operation: 'addition',
      tableNumber: 1,
      learnCompleted: true,
      practiceCorrect: 0,
      proveScore: 0,
      proveAvgTime: 0,
      placementUnlocked: false,
      updatedAt: new Date(),
    };
    dbMock.insert.mockImplementationOnce(() => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: () => Promise.resolve([upserted]),
        }),
      }),
    }));
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/maths/progress', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'addition', tableNumber: 1, learnCompleted: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { learnCompleted: boolean };
    expect(body.learnCompleted).toBe(true);
  });
});

// ─── POST /api/kid/maths/placement ───────────────────────────────────────────

describe('FHS-394 — POST /api/kid/maths/placement', () => {
  it('400 when body is missing operation', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/maths/placement', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ results: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('400 when results contain invalid tableNumber', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/maths/placement', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation: 'addition',
        results: [{ tableNumber: 0, correct: true, timeSeconds: 2 }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('200 + unlocked array on valid body (empty results → [])', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/maths/placement', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'addition', results: [] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { unlocked: number[] };
    expect(body.unlocked).toEqual([]);
  });
});

// ─── GET /api/kid/maths/certificates ─────────────────────────────────────────

describe('FHS-394 — GET /api/kid/maths/certificates', () => {
  it('200 + empty array when no certs', async () => {
    dbMock.select.mockImplementationOnce(() => ({
      from: () => ({ where: () => Promise.resolve([]) }),
    }));
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/maths/certificates', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { certificates: unknown[] };
    expect(body.certificates).toHaveLength(0);
  });
});

// ─── POST /api/kid/maths/certificates ────────────────────────────────────────

describe('FHS-394 — POST /api/kid/maths/certificates', () => {
  it('400 when difficulty is invalid', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/maths/certificates', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'addition', difficulty: '99', totalCorrect: 10 }),
    });
    expect(res.status).toBe(400);
  });

  it('400 when totalCorrect is 0', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/maths/certificates', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'addition', difficulty: 'easy', totalCorrect: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it('201 + alreadyEarned:false when cert is new', async () => {
    const created = {
      id: 'ccc',
      tenantId: TENANT_ID,
      memberId: MEMBER_ID,
      operation: 'addition',
      difficulty: 'easy',
      totalCorrect: 10,
      earnedAt: new Date(),
    };
    // select returns [] (no existing), insert returns the new row.
    dbMock.select.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }));
    dbMock.insert.mockImplementationOnce(() => ({
      values: () => ({
        returning: () => Promise.resolve([created]),
      }),
    }));
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/maths/certificates', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'addition', difficulty: 'easy', totalCorrect: 10 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { alreadyEarned: boolean };
    expect(body.alreadyEarned).toBe(false);
  });

  it('200 + alreadyEarned:true when cert already exists', async () => {
    const existing = {
      id: 'ddd',
      tenantId: TENANT_ID,
      memberId: MEMBER_ID,
      operation: 'multiplication',
      difficulty: '7',
      totalCorrect: 10,
      earnedAt: new Date(),
    };
    dbMock.select.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([existing]),
        }),
      }),
    }));
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/maths/certificates', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'multiplication', difficulty: '7', totalCorrect: 10 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alreadyEarned: boolean };
    expect(body.alreadyEarned).toBe(true);
  });

  it('400 when totalCorrect exceeds the max cap (1000)', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/maths/certificates', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'addition', difficulty: 'easy', totalCorrect: 9999 }),
    });
    expect(res.status).toBe(400);
  });
});

// ─── PUT progress: at least one stage field required ─────────────────────────

describe('FHS-394 — PUT /api/kid/maths/progress — stage-field requirement', () => {
  it('400 when body has operation + tableNumber but no stage field', async () => {
    const token = await mintKidToken();
    const res = await buildApp().request('/api/kid/maths/progress', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'addition', tableNumber: 5 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid request');
  });
});

// ─── Auth: parent-scope token is rejected on kid routes ──────────────────────

describe('FHS-394 — parent-scope token rejected on kid maths routes', () => {
  it('403 when a token with scope:parent hits GET /api/kid/maths/progress', async () => {
    const token = await mintParentScopeToken();
    const res = await buildApp().request('/api/kid/maths/progress', {
      headers: { Authorization: `Bearer ${token}` },
    });
    // kid-auth middleware rejects non-child scope tokens.
    expect(res.status).toBe(403);
  });
});
