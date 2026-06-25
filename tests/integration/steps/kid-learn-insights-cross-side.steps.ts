/**
 * Step bindings for kid-learn-insights-cross-side.feature (FHS-405).
 *
 * Cross-side consistency: a KID write (POST to kid Learn endpoints via HS256
 * token) must immediately surface in the PARENT Learn Insights read (GET via
 * Supabase ES256 token). Both sides share lib/learn-insights.ts + the same
 * Postgres rows, so these tests lock that wiring against regressions.
 *
 * Pattern mirrors kid-myworld-cross-side.steps.ts exactly:
 *  - parentApp: Supabase ES256 JWT + x-test-tenant header
 *  - kidApp:    HS256 kid JWT (scope: child)
 */

import { randomUUID } from 'node:crypto';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
  pinRequestTenant: async () => {},
}));

import { config } from '../../../apps/api/src/config.js';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { kidRouter } from '../../../apps/api/src/routes/kid.js';
import { learnInsightsRouter } from '../../../apps/api/src/routes/learn-insights.js';
import { tenants, members, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';

// ── Constants ────────────────────────────────────────────────────────────────

const KID_ISSUER = 'family-hub-kid-auth';
const SUPA_ISSUER = 'https://test.supabase.local/auth/v1';
const KID_JWK_ID = 'li-cross-side-int-kid';

// Stable Supabase user id for the admin parent. Distinct from myworld suite.
const ADMIN_USER_ID = '00000000-0000-4000-8000-000000000406';

// ── Science question IDs from learn-questions.ts ─────────────────────────────
//   sci-e1: answerIndex 0 (correct = True, the Sun is a star)
//   sci-e2: answerIndex 1 (correct = Dog is a mammal)
//   sci-h1: answerIndex 0 (correct = Oxygen)
//   sci-e3: answerIndex 0 (correct = Sunlight) — we'll submit index 1 (wrong)
const SCIENCE_CORRECT_1 = { questionId: 'sci-e1', choiceIndex: 0 }; // correct
const SCIENCE_CORRECT_2 = { questionId: 'sci-e2', choiceIndex: 1 }; // correct
const SCIENCE_CORRECT_3 = { questionId: 'sci-h1', choiceIndex: 0 }; // correct
const SCIENCE_WRONG = { questionId: 'sci-e3', choiceIndex: 1 }; // WRONG (correct is 0)

// For the certificate scenario: 10 correct answers reach CERTIFICATE_TARGET.
// We reuse the three correct questions above in a round-robin.
const CERT_ANSWERS = [
  SCIENCE_CORRECT_1,
  SCIENCE_CORRECT_2,
  SCIENCE_CORRECT_3,
  SCIENCE_CORRECT_1,
  SCIENCE_CORRECT_2,
  SCIENCE_CORRECT_3,
  SCIENCE_CORRECT_1,
  SCIENCE_CORRECT_2,
  SCIENCE_CORRECT_3,
  SCIENCE_CORRECT_1,
];

// ── Shared state (reset per Background) ──────────────────────────────────────

let db: Database;
let parentApp: Hono; // Supabase auth + tenant header + learn-insights route
let kidApp: Hono; // kid HS256 routes

let supaPrivateKey: KeyLike;
let supaPublicJwk: JWK;

const ctx: {
  tenantId: string;
  imanId: string;
  adminToken: string;
  imanKidToken: string;
  // per-step response capture
  lastKidStatuses: number[];
  lastKidStatus: number;
  lastKidBody: Record<string, unknown>;
  lastParentStatus: number;
  lastParentBody: Record<string, unknown>;
} = {} as never;

// ── Key + token helpers (same pattern as kid-myworld-cross-side.steps.ts) ────

async function genSupaKey() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = 'ES256';
  publicJwk.kid = KID_JWK_ID;
  publicJwk.use = 'sig';
  return { privateKey, publicJwk };
}

async function mintSupaToken(userId: string, email: string): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'ES256', kid: KID_JWK_ID })
    .setSubject(userId)
    .setIssuer(SUPA_ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(supaPrivateKey);
}

function makeJwks(publicJwk: JWK) {
  return async (header: { kid?: string; alg?: string }) => {
    const { importJWK } = await import('jose');
    if (header.kid !== publicJwk.kid) throw new Error(`no key for kid ${header.kid}`);
    return (await importJWK(publicJwk, header.alg ?? 'ES256')) as KeyLike;
  };
}

async function mintKidToken(memberId: string, tenantId: string, slug: string): Promise<string> {
  const secret = new TextEncoder().encode(config.KID_AUTH_SECRET);
  return new SignJWT({ tenantId, tenantSlug: slug, scope: 'child' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(memberId)
    .setIssuer(KID_ISSUER)
    .setExpirationTime('1h')
    .sign(secret);
}

// Middleware that resolves tenantId from a test-only header.
const resolveTenantFromHeader: MiddlewareHandler = async (c, next) => {
  c.set('tenantId', c.req.header('x-test-tenant'));
  await next();
};

function parentHeaders(token: string, tenantId: string) {
  return {
    Authorization: `Bearer ${token}`,
    'x-test-tenant': tenantId,
    'Content-Type': 'application/json',
  };
}

// ── Feature + describeFeature ─────────────────────────────────────────────────

const feature = await loadFeature(
  new URL('../features/kid-learn-insights-cross-side.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  // ── Background ────────────────────────────────────────────────────────────
  Background(({ Given }) => {
    Given(
      'a family with an admin parent and a kid "Iman" set up for learn-insights cross-side tests',
      async () => {
        db = getTestDb() as unknown as Database;
        await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
        await db.execute(sql`DELETE FROM users WHERE id = ${ADMIN_USER_ID}`);
        _resetJwksCacheForTests();

        // Supabase key + JWKS for parent route auth.
        const k = await genSupaKey();
        supaPrivateKey = k.privateKey;
        supaPublicJwk = k.publicJwk;

        // Users mirror row for the admin parent.
        await db.execute(
          sql`INSERT INTO users (id, email) VALUES (${ADMIN_USER_ID}, 'admin406@example.com')
              ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
        );

        // Seed family: tenant → admin member → kid member.
        const [t] = await db
          .insert(tenants)
          .values({
            slug: `li-${randomUUID().slice(0, 8)}`,
            name: 'LearnInsights Fam',
            currency: 'AED',
          })
          .returning();
        ctx.tenantId = t!.id;

        await db.insert(members).values({
          tenantId: t!.id,
          userId: ADMIN_USER_ID,
          displayName: 'Admin',
          role: 'admin',
        });

        const [iman] = await db
          .insert(members)
          .values({ tenantId: t!.id, displayName: 'Iman', role: 'child', isChild: true })
          .returning();
        ctx.imanId = iman!.id;

        // Mint tokens.
        ctx.adminToken = await mintSupaToken(ADMIN_USER_ID, 'admin406@example.com');
        ctx.imanKidToken = await mintKidToken(iman!.id, t!.id, t!.slug);

        // Reset per-step state.
        ctx.lastKidStatuses = [];
        ctx.lastKidStatus = 0;
        ctx.lastKidBody = {};
        ctx.lastParentStatus = 0;
        ctx.lastParentBody = {};

        // Parent app: Supabase auth + tenant-from-header + learn-insights route.
        parentApp = new Hono();
        parentApp.use(
          '*',
          authMiddleware({
            issuer: SUPA_ISSUER,
            jwks: makeJwks(supaPublicJwk),
            userMirrorSync: async (claims) => {
              const rows = await db
                .select()
                .from(users)
                .where(sql`id = ${claims.id}`)
                .limit(1);
              return rows[0]!;
            },
          }),
        );
        parentApp.use('*', resolveTenantFromHeader);
        parentApp.route('/api/learn/insights', learnInsightsRouter);

        // Kid app: kid HS256 auth + all kid routes.
        kidApp = new Hono();
        kidApp.route('/api/kid', kidRouter);
      },
    );
  });

  // ── Scenario 1: kid answers questions, parent sees progress + accuracy ─────
  Scenario(
    'kid answers Learn questions, parent insights show progress and accuracy',
    ({ When, Then, And }) => {
      When('kid "Iman" answers 3 Science questions correctly and 1 incorrectly', async () => {
        const answers = [SCIENCE_CORRECT_1, SCIENCE_CORRECT_2, SCIENCE_CORRECT_3, SCIENCE_WRONG];
        ctx.lastKidStatuses = [];
        for (const answer of answers) {
          const res = await kidApp.request('/api/kid/learn/Science/answer', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${ctx.imanKidToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(answer),
          });
          ctx.lastKidStatuses.push(res.status);
        }
      });

      Then('the learn answer responses are all 200', () => {
        for (const status of ctx.lastKidStatuses) {
          expect(status).toBe(200);
        }
      });

      When('the admin parent GETs learn insights for Iman', async () => {
        const res = await parentApp.request(`/api/learn/insights?memberId=${ctx.imanId}`, {
          headers: parentHeaders(ctx.adminToken, ctx.tenantId),
        });
        ctx.lastParentStatus = res.status;
        ctx.lastParentBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      });

      Then('the learn insights response status is 200', () => {
        expect(ctx.lastParentStatus).toBe(200);
      });

      And('the Science subject shows progressPct greater than 0', () => {
        const subjects = ctx.lastParentBody['subjects'] as Array<{
          subject: string;
          progressPct: number;
          accuracyPct: number | null;
          lastActive: string | null;
        }>;
        expect(Array.isArray(subjects)).toBe(true);
        const science = subjects.find((s) => s.subject === 'Science');
        expect(science).toBeDefined();
        expect(science!.progressPct).toBeGreaterThan(0);
      });

      And('the Science accuracyPct is 75', () => {
        // 3 correct out of 4 total = 75% (Math.floor(3/4 * 100) = 75).
        const subjects = ctx.lastParentBody['subjects'] as Array<{
          subject: string;
          accuracyPct: number | null;
        }>;
        const science = subjects.find((s) => s.subject === 'Science');
        expect(science?.accuracyPct).toBe(75);
      });

      And('the Science lastActive is set', () => {
        const subjects = ctx.lastParentBody['subjects'] as Array<{
          subject: string;
          lastActive: string | null;
        }>;
        const science = subjects.find((s) => s.subject === 'Science');
        expect(science?.lastActive).not.toBeNull();
        expect(typeof science?.lastActive).toBe('string');
      });
    },
  );

  // ── Scenario 2: kid earns a certificate, parent sees certificatesEarned ────
  Scenario(
    'kid earns a Science certificate, parent insights certificate count goes up',
    ({ When, Then, And }) => {
      When('kid "Iman" answers 10 Science questions correctly to earn a certificate', async () => {
        ctx.lastKidStatuses = [];
        for (const answer of CERT_ANSWERS) {
          const res = await kidApp.request('/api/kid/learn/Science/answer', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${ctx.imanKidToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(answer),
          });
          ctx.lastKidStatuses.push(res.status);
        }
      });

      Then('all 10 learn answer responses are 200', () => {
        expect(ctx.lastKidStatuses).toHaveLength(10);
        for (const status of ctx.lastKidStatuses) {
          expect(status).toBe(200);
        }
      });

      When('the admin parent GETs learn insights for Iman after the certificate', async () => {
        const res = await parentApp.request(`/api/learn/insights?memberId=${ctx.imanId}`, {
          headers: parentHeaders(ctx.adminToken, ctx.tenantId),
        });
        ctx.lastParentStatus = res.status;
        ctx.lastParentBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      });

      Then('the learn insights after-certificate response status is 200', () => {
        expect(ctx.lastParentStatus).toBe(200);
      });

      And('the Science certificatesEarned is 1', () => {
        const subjects = ctx.lastParentBody['subjects'] as Array<{
          subject: string;
          certificatesEarned: number;
        }>;
        expect(Array.isArray(subjects)).toBe(true);
        const science = subjects.find((s) => s.subject === 'Science');
        expect(science).toBeDefined();
        expect(science!.certificatesEarned).toBe(1);
      });
    },
  );

  // ── Scenario 3: kid completes a WF learn chunk, parent sees continent ──────
  Scenario(
    'kid completes a World Flags learn chunk, parent insights reflect the continent',
    ({ When, Then, And }) => {
      When('kid "Iman" completes the first Africa learn chunk', async () => {
        const res = await kidApp.request('/api/kid/world-flags/learn-complete', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ctx.imanKidToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ continent: 'Africa', chunkIndex: 0 }),
        });
        ctx.lastKidStatus = res.status;
        ctx.lastKidBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      });

      Then('the world-flags learn-complete response status is 200', () => {
        expect(ctx.lastKidStatus).toBe(200);
        expect(ctx.lastKidBody['completed']).toBe(true);
      });

      When('the admin parent GETs learn insights for Iman after the continent', async () => {
        const res = await parentApp.request(`/api/learn/insights?memberId=${ctx.imanId}`, {
          headers: parentHeaders(ctx.adminToken, ctx.tenantId),
        });
        ctx.lastParentStatus = res.status;
        ctx.lastParentBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      });

      Then('the learn insights after-continent response status is 200', () => {
        expect(ctx.lastParentStatus).toBe(200);
      });

      And('the World Flags subject shows continentsExplored of 1', () => {
        const subjects = ctx.lastParentBody['subjects'] as Array<{
          subject: string;
          continentsExplored: number;
        }>;
        expect(Array.isArray(subjects)).toBe(true);
        const wf = subjects.find((s) => s.subject === 'World Flags');
        expect(wf).toBeDefined();
        expect(wf!.continentsExplored).toBe(1);
      });

      And('Africa appears in exploredContinents', () => {
        const subjects = ctx.lastParentBody['subjects'] as Array<{
          subject: string;
          exploredContinents: string[];
        }>;
        const wf = subjects.find((s) => s.subject === 'World Flags');
        expect(wf?.exploredContinents).toContain('Africa');
      });
    },
  );
});
