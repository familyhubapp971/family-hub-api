// FHS-389 — POST /api/kid/learn/maths/ai-lesson
//
// Tests the flag-off path, input validation, system-prompt routing,
// and AI-error handling. No real Anthropic calls are made — fetch is mocked.
//
// Architecture note:
// - Flag OFF + validation tests use buildApp() — no DB needed (endpoint returns
//   early before any DB call when disabled, or rejects at body parse).
// - Flag ON tests use kidRouter directly with a mocked DB client so pinRequestTenant
//   doesn't try to open a real Postgres connection (same pattern as kid-world-flags.test.ts).

import { SignJWT } from 'jose';
import { Hono } from 'hono';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { config } from '../../../../apps/api/src/config.js';
import { KID_ISSUER } from '../../../../apps/api/src/middleware/kid-auth.js';

// ─── DB mock — scoped to this module ────────────────────────────────────────

vi.mock('../../../../apps/api/src/db/client.js', () => ({
  getDb: () => ({}),
  pinRequestTenant: async () => {},
}));

// Import AFTER mock so routes pick up the mocked client.
const { kidRouter } = await import('../../../../apps/api/src/routes/kid.js');

// ─── Helpers ────────────────────────────────────────────────────────────────

const KEY = new TextEncoder().encode(config.KID_AUTH_SECRET);
const MEMBER_ID = '44444444-4444-4444-8444-444444444444';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_SLUG = 'test-family';

async function mintKidToken(secondsFromNow = 3600): Promise<string> {
  return new SignJWT({ scope: 'child', tenantId: TENANT_ID, tenantSlug: TENANT_SLUG })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(MEMBER_ID)
    .setIssuer(KID_ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + secondsFromNow)
    .sign(KEY);
}

function makeApp(): Hono {
  return new Hono().route('/', kidRouter);
}

// A minimal valid lesson shape that Zod will accept.
const MOCK_LESSON = {
  concept: 'Adding means putting two groups of things together to find how many there are.',
  visual: {
    description: '3 apples then 2 more apples arrive',
    emoji: '🍎',
    groups: 2,
    perGroup: 3,
    total: 5,
    equation: '3 + 2 = 5',
  },
  stickyPhrase: 'When you add, the number gets bigger!',
  gapCheck: 'Adding does not mean subtracting — you are making more, not less.',
  practice: [
    {
      emoji: '🍎',
      groups: 2,
      perGroup: 1,
      question: '1 + 2 = ?',
      answer: 3,
      choices: [3, 1, 4, 2],
    },
    {
      emoji: '⭐',
      groups: 2,
      perGroup: 2,
      question: '2 + 3 = ?',
      answer: 5,
      choices: [5, 4, 6, 3],
    },
    {
      emoji: '🍬',
      groups: 2,
      perGroup: 4,
      question: '4 + 1 = ?',
      answer: 5,
      choices: [5, 6, 3, 7],
    },
  ],
};

function mockAnthropicResponse(lesson: unknown): Response {
  return new Response(
    JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(lesson) }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function mockAnthropicError(status = 500): Response {
  return new Response(JSON.stringify({ error: 'server error' }), { status });
}

// Exact host match (not a substring/startsWith) so the URL check is precise.
function isAnthropicUrl(u: unknown): boolean {
  try {
    return new URL(String(u)).host === 'api.anthropic.com';
  } catch {
    return false;
  }
}

const originalFetch = global.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  global.fetch = originalFetch;
  // Reset AI flag after each test.
  Object.defineProperty(config, 'LEARN_AI_ENABLED', { value: false, configurable: true });
  Object.defineProperty(config, 'ANTHROPIC_API_KEY', { value: '', configurable: true });
});

function enableAI() {
  Object.defineProperty(config, 'LEARN_AI_ENABLED', { value: true, configurable: true });
  Object.defineProperty(config, 'ANTHROPIC_API_KEY', {
    value: 'sk-ant-fake-key',
    configurable: true,
  });
}

// ── GET status probe — cheap, never generates / never calls Anthropic ────────

describe('FHS-389 — GET /learn/maths/ai-lesson/status', () => {
  it('returns { enabled: false } when off, with no Anthropic call', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const token = await mintKidToken();
    const res = await makeApp().request('/learn/maths/ai-lesson/status', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { enabled: boolean }).enabled).toBe(false);
    expect(fetchSpy.mock.calls.filter(([u]) => isAnthropicUrl(u))).toHaveLength(0);
  });

  it('returns { enabled: true } when on, STILL with no Anthropic call', async () => {
    enableAI();
    const fetchSpy = vi.spyOn(global, 'fetch');
    const token = await mintKidToken();
    const res = await makeApp().request('/learn/maths/ai-lesson/status', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { enabled: boolean }).enabled).toBe(true);
    expect(fetchSpy.mock.calls.filter(([u]) => isAnthropicUrl(u))).toHaveLength(0);
  });

  it('403 without a kid token', async () => {
    const res = await makeApp().request('/learn/maths/ai-lesson/status');
    expect(res.status).toBe(403);
  });
});

// ── Flag OFF (default in test env) ──────────────────────────────────────────

describe('FHS-389 — POST /learn/maths/ai-lesson — flag OFF', () => {
  it('returns 200 { enabled: false } when flag is off', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const token = await mintKidToken();
    const res = await makeApp().request('/learn/maths/ai-lesson', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'addition', difficulty: 'easy' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(false);
    // No Anthropic call made.
    const anthropicCalls = fetchSpy.mock.calls.filter(([url]) => isAnthropicUrl(url));
    expect(anthropicCalls).toHaveLength(0);
  });

  it('returns { enabled: false } regardless of body contents when flag is off', async () => {
    const token = await mintKidToken();
    const res = await makeApp().request('/learn/maths/ai-lesson', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'multiplication', tableNumber: 5 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { enabled: boolean }).enabled).toBe(false);
  });
});

// ── Input validation (flag ON so the endpoint reaches the validation) ────────

describe('FHS-389 — POST /learn/maths/ai-lesson — validation', () => {
  beforeEach(() => {
    enableAI();
    // Return a valid lesson so validation-passing tests don't error on Anthropic.
    global.fetch = vi.fn().mockResolvedValue(mockAnthropicResponse(MOCK_LESSON));
  });

  it('returns 400 when body is null / not parseable', async () => {
    global.fetch = vi.fn().mockResolvedValue(mockAnthropicResponse(MOCK_LESSON));
    const token = await mintKidToken();
    const res = await makeApp().request('/learn/maths/ai-lesson', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(null),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when operation is missing', async () => {
    const token = await mintKidToken();
    const res = await makeApp().request('/learn/maths/ai-lesson', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ difficulty: 'easy' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when neither difficulty nor tableNumber is supplied', async () => {
    const token = await mintKidToken();
    const res = await makeApp().request('/learn/maths/ai-lesson', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'addition' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid request');
  });

  it('returns 400 when operation is unknown', async () => {
    const token = await mintKidToken();
    const res = await makeApp().request('/learn/maths/ai-lesson', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'modulus', difficulty: 'easy' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when tableNumber is 0', async () => {
    const token = await mintKidToken();
    const res = await makeApp().request('/learn/maths/ai-lesson', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'multiplication', tableNumber: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when tableNumber is 13 (out of range)', async () => {
    const token = await mintKidToken();
    const res = await makeApp().request('/learn/maths/ai-lesson', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'multiplication', tableNumber: 13 }),
    });
    expect(res.status).toBe(400);
  });
});

// ── Flag ON — successful AI response ────────────────────────────────────────

describe('FHS-389 — POST /learn/maths/ai-lesson — flag ON, success', () => {
  beforeEach(() => enableAI());

  it('returns 200 { enabled: true, lesson } when AI responds with valid JSON', async () => {
    global.fetch = vi.fn().mockResolvedValue(mockAnthropicResponse(MOCK_LESSON));
    const token = await mintKidToken();
    const res = await makeApp().request('/learn/maths/ai-lesson', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'addition', difficulty: 'easy' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; lesson: typeof MOCK_LESSON };
    expect(body.enabled).toBe(true);
    expect(body.lesson).toBeDefined();
    expect(body.lesson.practice).toHaveLength(3);
  });

  it('includes ADDITION (+) in the system prompt for operation=addition', async () => {
    let capturedBody = '';
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return mockAnthropicResponse(MOCK_LESSON);
    });
    const token = await mintKidToken();
    await makeApp().request('/learn/maths/ai-lesson', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'addition', difficulty: 'easy' }),
    });
    const parsed = JSON.parse(capturedBody) as { system: string };
    expect(parsed.system).toContain('ADDITION (+)');
    expect(parsed.system).toContain('Show combining two amounts together');
  });

  it('includes MULTIPLICATION (×) in the system prompt for operation=multiplication', async () => {
    let capturedBody = '';
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return mockAnthropicResponse(MOCK_LESSON);
    });
    const token = await mintKidToken();
    await makeApp().request('/learn/maths/ai-lesson', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'multiplication', difficulty: 'medium' }),
    });
    const parsed = JSON.parse(capturedBody) as { system: string };
    expect(parsed.system).toContain('MULTIPLICATION (×)');
    expect(parsed.system).toContain('Show equal groups of items');
  });

  it('includes SUBTRACTION (-) in the system prompt for operation=subtraction', async () => {
    let capturedBody = '';
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return mockAnthropicResponse(MOCK_LESSON);
    });
    const token = await mintKidToken();
    await makeApp().request('/learn/maths/ai-lesson', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'subtraction', difficulty: 'hard' }),
    });
    const parsed = JSON.parse(capturedBody) as { system: string };
    expect(parsed.system).toContain('SUBTRACTION (-)');
    expect(parsed.system).toContain('no negatives');
  });

  it('includes DIVISION (÷) in the system prompt for operation=division', async () => {
    let capturedBody = '';
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return mockAnthropicResponse(MOCK_LESSON);
    });
    const token = await mintKidToken();
    await makeApp().request('/learn/maths/ai-lesson', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'division', difficulty: 'easy' }),
    });
    const parsed = JSON.parse(capturedBody) as { system: string };
    expect(parsed.system).toContain('DIVISION (÷)');
    expect(parsed.system).toContain('no remainders');
  });

  it('accepts tableNumber in place of difficulty and returns a lesson', async () => {
    global.fetch = vi.fn().mockResolvedValue(mockAnthropicResponse(MOCK_LESSON));
    const token = await mintKidToken();
    const res = await makeApp().request('/learn/maths/ai-lesson', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'multiplication', tableNumber: 7 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { enabled: boolean }).enabled).toBe(true);
  });
});

// ── Flag ON — AI failure ─────────────────────────────────────────────────────

describe('FHS-389 — POST /learn/maths/ai-lesson — flag ON, AI failure', () => {
  beforeEach(() => enableAI());

  it('returns 200 { enabled:true, lesson:null, error } when Anthropic returns 500', async () => {
    global.fetch = vi.fn().mockResolvedValue(mockAnthropicError(500));
    const token = await mintKidToken();
    const res = await makeApp().request('/learn/maths/ai-lesson', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'subtraction', difficulty: 'hard' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; lesson: null; error: string };
    expect(body.enabled).toBe(true);
    expect(body.lesson).toBeNull();
    expect(typeof body.error).toBe('string');
  });

  it('returns 200 { enabled:true, lesson:null } when AI returns malformed JSON', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'not valid json {{{' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const token = await mintKidToken();
    const res = await makeApp().request('/learn/maths/ai-lesson', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'division', difficulty: 'easy' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; lesson: null };
    expect(body.enabled).toBe(true);
    expect(body.lesson).toBeNull();
  });

  it('returns 200 { enabled:true, lesson:null } when AI JSON fails Zod validation', async () => {
    // Valid JSON but missing required fields.
    const badLesson = { concept: 'test', stickyPhrase: 'test' };
    global.fetch = vi.fn().mockResolvedValue(mockAnthropicResponse(badLesson));
    const token = await mintKidToken();
    const res = await makeApp().request('/learn/maths/ai-lesson', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'addition', difficulty: 'easy' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; lesson: null };
    expect(body.enabled).toBe(true);
    expect(body.lesson).toBeNull();
  });
});

// ── Auth guard ────────────────────────────────────────────────────────────────

describe('FHS-389 — POST /learn/maths/ai-lesson — auth', () => {
  it('returns 403 (KID_REQUIRED) when called without a kid token', async () => {
    // kidRouter runs kidAuthMiddleware + requireKidAuth on every route, so
    // a request with no Bearer token is rejected with 403 before reaching the handler.
    const res = await makeApp().request('/learn/maths/ai-lesson', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'addition', difficulty: 'easy' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errorCode: string };
    expect(body.errorCode).toBe('KID_REQUIRED');
  });

  it('returns 401 (KID_AUTH_INVALID) for a tampered kid token', async () => {
    const token = await mintKidToken();
    const res = await makeApp().request('/learn/maths/ai-lesson', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.slice(0, -3)}xyz`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ operation: 'addition', difficulty: 'easy' }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe('KID_AUTH_INVALID');
  });
});
