// FHS-384 — Integration step definitions for learn-insights.feature.
//
// Uses real Postgres on :5433. The DB is truncated in Background so each
// Scenario starts clean. Auth is wired with a real ES256 JWT (same pattern
// as mw-analytics.steps.ts). The app is built from the real route only —
// no full-app spin-up needed.
//
// @amiceli/vitest-cucumber rule: every step referenced in the feature must be
// bound inside the correct Scenario/Background callback with the exact keywords
// used. All steps are destructured per-Scenario to satisfy the lint rule.

import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { learnInsightsRouter } from '../../../apps/api/src/routes/learn-insights.js';
import { members, mwMathsCertificates, tenants, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

// ─── Mock the DB so the router calls the test pool ───────────────────────────

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

// ─── Load feature ─────────────────────────────────────────────────────────────

const feature = await loadFeature(
  new URL('../features/learn-insights.feature', import.meta.url).pathname,
);

// ─── Key / JWT helpers ────────────────────────────────────────────────────────

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'learn-insights-test-kid';
const PARENT_USER_ID = '00000000-0000-4000-8000-000000000abc';
const PARENT_EMAIL = 'parent-insights@example.com';
const KID_USER_ID = '00000000-0000-4000-8000-000000000bbb';

async function genKey() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = 'ES256';
  publicJwk.kid = KID;
  publicJwk.use = 'sig';
  return { privateKey, publicJwk };
}

async function mintToken(privateKey: KeyLike, userId: string, email: string) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey);
}

function makeJwks(publicJwk: JWK) {
  return async (header: { kid?: string; alg?: string }) => {
    const { importJWK } = await import('jose');
    if (header.kid !== publicJwk.kid) throw new Error(`no key for kid ${header.kid}`);
    return (await importJWK(publicJwk, header.alg ?? 'ES256')) as KeyLike;
  };
}

const resolveTenantFromHeader: MiddlewareHandler = async (c, next) => {
  c.set('tenantId', c.req.header('x-test-tenant'));
  await next();
};

// ─── describeFeature ──────────────────────────────────────────────────────────

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let token: string;
  let kidToken: string;
  // Shared private key — exposed at closure level so kid-caller step can reuse.
  let sharedPrivateKey: KeyLike;
  const tenantIds: Record<string, string> = {};
  const memberIds: Record<string, string> = {};

  let lastResponse: { status: number; body: Record<string, unknown> };

  function headers(tenantSlug: string, useKidToken = false) {
    return {
      Authorization: `Bearer ${useKidToken ? kidToken : token}`,
      'x-test-tenant': tenantIds[tenantSlug]!,
      'Content-Type': 'application/json',
    };
  }

  async function getInsights(memberName: string, tenantSlug: string, useKidToken = false) {
    const memberId = memberIds[memberName];
    const res = await app.request(`/api/learn/insights?memberId=${memberId ?? 'unknown-id'}`, {
      headers: headers(tenantSlug, useKidToken),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    lastResponse = { status: res.status, body };
  }

  // ── Background ─────────────────────────────────────────────────────────────

  Background(({ Given, And }) => {
    Given('the test Postgres has clean learn insights tables', async () => {
      db = getTestDb() as unknown as Database;

      // Truncate all relevant tables in dependency order.
      await db.execute(sql`TRUNCATE TABLE mw_maths_certificates RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE mw_maths_progress RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE mw_logic_certificates RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE mw_logic_progress RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE learn_progress RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE world_flags_progress RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      // Clean both the parent and the kid user so each Scenario starts fresh.
      await db.execute(sql`DELETE FROM users WHERE id IN (${PARENT_USER_ID}, ${KID_USER_ID})`);
      _resetJwksCacheForTests();
      for (const m of [tenantIds, memberIds]) {
        for (const k of Object.keys(m)) delete m[k];
      }
    });

    And('a users mirror row exists for the learn insights caller', async () => {
      await db.execute(
        sql`INSERT INTO users (id, email) VALUES (${PARENT_USER_ID}, ${PARENT_EMAIL})
            ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      );
      const { privateKey, publicJwk } = await genKey();
      sharedPrivateKey = privateKey; // expose for kid-caller step

      app = new Hono();
      app.use(
        '*',
        authMiddleware({
          issuer: ISSUER,
          jwks: makeJwks(publicJwk),
          // userMirrorSync resolves by claims.id (= JWT sub).
          // The kid-caller Scenario uses the same app with a different sub,
          // so the callback MUST use claims.id rather than a hardcoded user.
          userMirrorSync: async (claims) => {
            const rows = await db
              .select()
              .from(users)
              .where(sql`id = ${claims.id}`)
              .limit(1);
            if (!rows[0]) throw new Error(`users-mirror row not found for id=${claims.id}`);
            return rows[0];
          },
        }),
      );
      app.use('*', resolveTenantFromHeader);
      app.route('/api/learn/insights', learnInsightsRouter);
      token = await mintToken(privateKey, PARENT_USER_ID, PARENT_EMAIL);
    });

    And('a tenant {string} exists with the caller as an admin member', async (_c, slug: string) => {
      const [tenant] = await db
        .insert(tenants)
        .values({ slug, name: `${slug} Family` })
        .returning();
      tenantIds[slug] = tenant!.id;
      await db.insert(members).values({
        tenantId: tenant!.id,
        userId: PARENT_USER_ID,
        displayName: 'Parent',
        role: 'admin',
      });
    });

    And(
      'the {string} tenant has a child member {string}',
      async (_c, slug: string, name: string) => {
        const [row] = await db
          .insert(members)
          .values({
            tenantId: tenantIds[slug]!,
            userId: null,
            displayName: name,
            role: 'child',
            isChild: true,
          })
          .returning();
        memberIds[name] = row!.id;
      },
    );

    And(
      'a second tenant {string} exists with a child member {string}',
      async (_c, slug: string, name: string) => {
        const [tenant] = await db
          .insert(tenants)
          .values({ slug, name: `${slug} Family` })
          .returning();
        tenantIds[slug] = tenant!.id;
        const [childRow] = await db
          .insert(members)
          .values({
            tenantId: tenant!.id,
            userId: null,
            displayName: name,
            role: 'child',
            isChild: true,
          })
          .returning();
        memberIds[name] = childRow!.id;
      },
    );
  });

  // ── Scenario: parent reads insights with seeded Maths data ────────────────

  Scenario(
    "a parent reads a child's insights with seeded Maths progress",
    ({ Given, When, Then, And }) => {
      Given(
        '{string} has {int} maths certificates in {string}',
        async (_c, name: string, count: number, slug: string) => {
          const ops = ['addition', 'subtraction', 'multiplication', 'division'];
          let inserted = 0;
          for (const op of ops) {
            for (let t = 1; t <= 12 && inserted < count; t++) {
              await db.insert(mwMathsCertificates).values({
                tenantId: tenantIds[slug]!,
                memberId: memberIds[name]!,
                operation: op,
                difficulty: String(t),
                totalCorrect: 10,
              });
              inserted++;
            }
          }
        },
      );

      When(
        'the caller GETs learn insights for {string} in {string}',
        async (_c, name: string, slug: string) => {
          await getInsights(name, slug);
        },
      );

      Then('the learn insights response status is {int}', (_c, status: number) => {
        expect(lastResponse.status).toBe(status);
      });

      And('the learn insights memberId matches {string}', (_c, name: string) => {
        expect(lastResponse.body.memberId).toBe(memberIds[name]);
      });

      And('the learn insights Maths subject has certificatesEarned {int}', (_c, earned: number) => {
        const subjects = lastResponse.body.subjects as Array<{
          subject: string;
          certificatesEarned: number;
        }>;
        const maths = subjects.find((s) => s.subject === 'Maths');
        expect(maths?.certificatesEarned).toBe(earned);
      });

      And('the learn insights Maths progressPct is {int}', (_c, pct: number) => {
        const subjects = lastResponse.body.subjects as Array<{
          subject: string;
          progressPct: number;
        }>;
        const maths = subjects.find((s) => s.subject === 'Maths');
        expect(maths?.progressPct).toBe(pct);
      });

      And('the learn insights hasActivity is {word}', (_c, val: string) => {
        expect(lastResponse.body.hasActivity).toBe(val === 'true');
      });
    },
  );

  // ── Scenario: empty state ──────────────────────────────────────────────────

  Scenario('empty state — a child with no Learn activity', ({ When, Then, And }) => {
    When(
      'the caller GETs learn insights for {string} in {string}',
      async (_c, name: string, slug: string) => {
        await getInsights(name, slug);
      },
    );

    Then('the learn insights response status is {int}', (_c, status: number) => {
      expect(lastResponse.status).toBe(status);
    });

    And('the learn insights hasActivity is {word}', (_c, val: string) => {
      expect(lastResponse.body.hasActivity).toBe(val === 'true');
    });

    And('the learn insights weakest is null', () => {
      expect(lastResponse.body.weakest).toBeNull();
    });

    And('every subject has progressPct 0', () => {
      const subjects = lastResponse.body.subjects as Array<{ progressPct: number }>;
      for (const s of subjects) {
        expect(s.progressPct).toBe(0);
      }
    });
  });

  // ── Scenario: tenant isolation ─────────────────────────────────────────────

  Scenario(
    'tenant isolation — a parent cannot read a child in another tenant',
    ({ When, Then }) => {
      When(
        'the caller GETs learn insights for {string} in {string}',
        async (_c, name: string, slug: string) => {
          // Omar is in "other-family"; caller's x-test-tenant header is "insight-family".
          // The member lookup (tenantId = insight-family, id = Omar.id) returns 0 rows → 404.
          await getInsights(name, slug);
        },
      );

      Then('the learn insights response status is {int}', (_c, status: number) => {
        expect(lastResponse.status).toBe(status);
      });
    },
  );

  // ── Scenario: kid caller is rejected ──────────────────────────────────────

  Scenario('kid-role caller is rejected (403 ADULT_REQUIRED)', ({ Given, When, Then, And }) => {
    Given('a kid caller {string} in {string}', async (_c, name: string, slug: string) => {
      // Create a child member with its own user identity so we can mint a JWT
      // for it. The role check comes from the DB (members.role = 'child'), not
      // the JWT payload, so we reuse the SAME app and SAME keypair built in
      // Background — just with a different sub claim (kid's userId).
      const kidEmail = `${name.toLowerCase()}@example.com`;

      // Insert the kid user so userMirrorSync can resolve claims.sub.
      await db.execute(
        sql`INSERT INTO users (id, email) VALUES (${KID_USER_ID}, ${kidEmail})
            ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      );
      await db.insert(members).values({
        tenantId: tenantIds[slug]!,
        userId: KID_USER_ID,
        displayName: name,
        role: 'child',
        isChild: true,
      });
      memberIds[name] = KID_USER_ID;

      // Mint using the shared parent private key (same JWKS as the existing
      // app). The sub is the kid's userId — isAdminOrAdult() returns false
      // because members.role = 'child' in the DB → 403 ADULT_REQUIRED.
      kidToken = await mintToken(sharedPrivateKey, KID_USER_ID, kidEmail);
    });

    When(
      'the kid caller GETs learn insights for {string} in {string}',
      async (_c, name: string, slug: string) => {
        await getInsights(name, slug, true);
      },
    );

    Then('the learn insights response status is {int}', (_c, status: number) => {
      expect(lastResponse.status).toBe(status);
    });

    And('the learn insights error code is {string}', (_c, code: string) => {
      expect((lastResponse.body as { errorCode?: string }).errorCode).toBe(code);
    });
  });
});
