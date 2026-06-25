// FHS-384 — Unit tests for routes/learn-insights.ts
//
// Tests cover the HTTP layer: auth guards, tenant checks, role enforcement,
// cross-tenant / non-existent memberId, and empty-state shape.
// The computeLearnInsights helper is stubbed out — its logic is separately
// unit-tested in tests/unit/api/lib/learn-insights.test.ts.

import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { learnInsightsRouter } from '../../../../apps/api/src/routes/learn-insights.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// ─── Mock the DB client ───────────────────────────────────────────────────────

const dbMock = { select: vi.fn() };
vi.mock('../../../../apps/api/src/db/client.js', () => ({ getDb: () => dbMock }));

// ─── Mock the aggregation helper ─────────────────────────────────────────────

vi.mock('../../../../apps/api/src/lib/learn-insights.js', () => ({
  computeLearnInsights: vi.fn(),
  MATHS_CERTS_TOTAL: 48,
  LOGIC_CERTS_TOTAL: 15,
  WORLD_FLAGS_COUNTRIES_TOTAL: 197,
  WORLD_FLAGS_CONTINENTS_TOTAL: 6,
}));

import { computeLearnInsights } from '../../../../apps/api/src/lib/learn-insights.js';
const mockCompute = computeLearnInsights as ReturnType<typeof vi.fn>;

// ─── Constants ────────────────────────────────────────────────────────────────

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '00000000-0000-4000-8000-000000000abc';
const CHILD_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const FIXED_USER: User = {
  id: USER_ID,
  email: 'parent@example.com',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

const STUB_INSIGHTS = {
  memberId: CHILD_ID,
  subjects: [
    {
      subject: 'Maths' as const,
      progressPct: 10,
      certificatesEarned: 5,
      certificatesTotal: 48,
      lastActive: null,
      needsHelp: false,
      accuracyPct: null, // FHS-401
    },
    {
      subject: 'Logic' as const,
      progressPct: 0,
      certificatesEarned: 0,
      certificatesTotal: 15,
      lastActive: null,
      needsHelp: false,
      accuracyPct: null,
    },
    {
      subject: 'Science' as const,
      progressPct: 0,
      certificatesEarned: 0,
      certificatesTotal: 1,
      lastActive: null,
      needsHelp: false,
      accuracyPct: null,
    },
    {
      subject: 'World Flags' as const,
      progressPct: 0,
      certificatesEarned: 0,
      certificatesTotal: 6,
      lastActive: null,
      needsHelp: false,
      accuracyPct: null,
    },
  ],
  weakest: null,
  hasActivity: false,
};

// ─── App builder ─────────────────────────────────────────────────────────────

function buildApp({
  callerRole,
  noTenant = false,
  targetMemberExists = true,
  targetRole = 'child',
}: {
  callerRole: string | null;
  noTenant?: boolean;
  targetMemberExists?: boolean;
  /** Role of the target member returned by the DB mock (default: 'child') */
  targetRole?: string;
}) {
  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: FIXED_USER.email, claims: {} });
    c.set('userRow', FIXED_USER);
    if (!noTenant) c.set('tenantId', TENANT_ID);
    await next();
  };

  // DB calls in handler order:
  // 1) loadCaller: select().from().where().limit(1) → caller member row
  // 2) target member lookup: select().from().where().limit(1) → target row
  let selectCallCount = 0;
  dbMock.select.mockImplementation(() => {
    selectCallCount++;
    const callNo = selectCallCount;
    return {
      from: () => ({
        where: () => ({
          limit: () => {
            if (callNo === 1) {
              // loadCaller — returns a member with the specified caller role
              return Promise.resolve(
                callerRole ? [{ id: 'caller-member-id', role: callerRole }] : [],
              );
            }
            // target member lookup — returns the child row (role included)
            return Promise.resolve(
              targetMemberExists
                ? [{ id: CHILD_ID, displayName: 'TestChild', role: targetRole }]
                : [],
            );
          },
        }),
      }),
    };
  });

  const app = new Hono();
  app.use('*', seed);
  app.route('/api/learn/insights', learnInsightsRouter);
  return app;
}

function get(memberId: string) {
  return `/api/learn/insights?memberId=${memberId}`;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  dbMock.select.mockReset();
  mockCompute.mockReset();
  mockCompute.mockResolvedValue(STUB_INSIGHTS);
});

describe('GET /api/learn/insights — tenant guard', () => {
  it('400 TENANT_REQUIRED when no tenant on context', async () => {
    const res = await buildApp({ callerRole: 'admin', noTenant: true }).request(get(CHILD_ID));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errorCode: string };
    expect(body.errorCode).toBe('TENANT_REQUIRED');
  });
});

describe('GET /api/learn/insights — memberId validation', () => {
  it('400 when memberId is missing', async () => {
    const app = buildApp({ callerRole: 'admin' });
    const res = await app.request('/api/learn/insights');
    expect(res.status).toBe(400);
  });

  it('400 when memberId is not a UUID', async () => {
    const app = buildApp({ callerRole: 'admin' });
    const res = await app.request('/api/learn/insights?memberId=not-a-uuid');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/learn/insights — caller membership', () => {
  it('403 when caller is not a member of the tenant', async () => {
    const res = await buildApp({ callerRole: null }).request(get(CHILD_ID));
    expect(res.status).toBe(403);
  });
});

describe('GET /api/learn/insights — role enforcement (kids blocked)', () => {
  it('403 ADULT_REQUIRED for role=child', async () => {
    const res = await buildApp({ callerRole: 'child' }).request(get(CHILD_ID));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errorCode: string };
    expect(body.errorCode).toBe('ADULT_REQUIRED');
  });

  it('403 ADULT_REQUIRED for role=teen', async () => {
    const res = await buildApp({ callerRole: 'teen' }).request(get(CHILD_ID));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errorCode: string };
    expect(body.errorCode).toBe('ADULT_REQUIRED');
  });

  it('403 ADULT_REQUIRED for role=guest', async () => {
    const res = await buildApp({ callerRole: 'guest' }).request(get(CHILD_ID));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errorCode: string };
    expect(body.errorCode).toBe('ADULT_REQUIRED');
  });
});

describe('GET /api/learn/insights — target member guard', () => {
  it('404 when target member does not exist in this tenant', async () => {
    const res = await buildApp({ callerRole: 'admin', targetMemberExists: false }).request(
      get(CHILD_ID),
    );
    expect(res.status).toBe(404);
  });

  it('403 TARGET_NOT_CHILD when target is an adult member', async () => {
    // An admin caller requesting learn insights for another adult member
    // is not supported — learn insights are child-only.
    const res = await buildApp({ callerRole: 'admin', targetRole: 'adult' }).request(get(CHILD_ID));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errorCode: string };
    expect(body.errorCode).toBe('TARGET_NOT_CHILD');
  });

  it('403 TARGET_NOT_CHILD when target is an admin member', async () => {
    const res = await buildApp({ callerRole: 'admin', targetRole: 'admin' }).request(get(CHILD_ID));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errorCode: string };
    expect(body.errorCode).toBe('TARGET_NOT_CHILD');
  });
});

describe('GET /api/learn/insights — success path', () => {
  it('200 for admin caller with correct response shape', async () => {
    const res = await buildApp({ callerRole: 'admin' }).request(get(CHILD_ID));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      memberId: string;
      displayName: string;
      subjects: unknown[];
      weakest: null;
      hasActivity: boolean;
    };
    expect(body.memberId).toBe(CHILD_ID);
    expect(body.displayName).toBe('TestChild');
    expect(Array.isArray(body.subjects)).toBe(true);
    expect(body.subjects).toHaveLength(4);
    expect(body.hasActivity).toBe(false);
    expect(body.weakest).toBeNull();
  });

  it('200 for adult caller', async () => {
    const res = await buildApp({ callerRole: 'adult' }).request(get(CHILD_ID));
    expect(res.status).toBe(200);
  });

  it('calls computeLearnInsights with correct tenantId and memberId', async () => {
    await buildApp({ callerRole: 'admin' }).request(get(CHILD_ID));
    expect(mockCompute).toHaveBeenCalledWith(expect.anything(), TENANT_ID, CHILD_ID);
  });

  it('empty-state shape: hasActivity false, weakest null, all subjects zeroed', async () => {
    const res = await buildApp({ callerRole: 'admin' }).request(get(CHILD_ID));
    const body = (await res.json()) as {
      subjects: Array<{ subject: string; progressPct: number; certificatesEarned: number }>;
      hasActivity: boolean;
      weakest: null;
    };
    expect(body.hasActivity).toBe(false);
    expect(body.weakest).toBeNull();
    for (const s of body.subjects) {
      // STUB_INSIGHTS has Maths at progressPct=10; all others at 0.
      expect(s.progressPct).toBe(s.subject === 'Maths' ? 10 : 0);
    }
  });
});
