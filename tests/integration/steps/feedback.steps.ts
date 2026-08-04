import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql, eq } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { feedbackRouter } from '../../../apps/api/src/routes/feedback.js';
import { tenants, members, users, betaFeedback } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

// Unique KID + USER_ID so this file doesn't collide with other step files
// running on the same Postgres instance.
const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'feedback-int-kid';
const USER_ID = '00000000-0000-4000-8000-000000000fbd';
const USER_EMAIL = 'feedback-tester@example.com';

vi.mock('../../../apps/api/src/db/client.js', () => ({ getDb: () => getTestDb() }));

const feature = await loadFeature(
  new URL('../features/feedback.feature', import.meta.url).pathname,
);

async function genKey() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = 'ES256';
  publicJwk.kid = KID;
  publicJwk.use = 'sig';
  return { privateKey, publicJwk };
}

async function mintToken(privateKey: KeyLike) {
  return new SignJWT({ email: USER_EMAIL })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setSubject(USER_ID)
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

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let token: string;
  const tenantIds: Record<string, string> = {};

  // Last response from a POST call.
  let lastRes: Response;
  let lastBody: unknown;

  function authHeaders(slug: string) {
    return {
      Authorization: `Bearer ${token}`,
      'x-test-tenant': tenantIds[slug]!,
      'Content-Type': 'application/json',
    };
  }

  Background(({ Given, And }) => {
    Given('the feedback test DB is clean', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE beta_feedback RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
      _resetJwksCacheForTests();
      for (const k of Object.keys(tenantIds)) delete tenantIds[k];
    });

    And('a users mirror row exists for the feedback test caller', async () => {
      await db.execute(
        sql`INSERT INTO users (id, email) VALUES (${USER_ID}, ${USER_EMAIL})
            ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      );
      const { privateKey, publicJwk } = await genKey();
      app = new Hono();
      app.use(
        '*',
        authMiddleware({
          issuer: ISSUER,
          jwks: makeJwks(publicJwk),
          userMirrorSync: async () => {
            const rows = await db
              .select()
              .from(users)
              .where(sql`id = ${USER_ID}`)
              .limit(1);
            return rows[0]!;
          },
        }),
      );
      app.use('*', resolveTenantFromHeader);
      app.route('/api/feedback', feedbackRouter);
      token = await mintToken(privateKey);
    });

    And(
      'a feedback tenant {string} exists with the caller as an admin member',
      async (_ctx, slug: string) => {
        const [t] = await db
          .insert(tenants)
          .values({ slug, name: `${slug} Family` })
          .returning();
        tenantIds[slug] = t!.id;
        await db.insert(members).values({
          tenantId: t!.id,
          userId: USER_ID,
          displayName: 'Caller',
          role: 'admin',
        });
      },
    );
  });

  Scenario('POST with valid answers returns 201 and persists the row', ({ When, Then, And }) => {
    When(
      'the caller POSTs feedback to {string} with pmfDisappointment {string} and painPoint {string}',
      async (_ctx, slug: string, pmf: string, pain: string) => {
        lastRes = await app.request('/api/feedback', {
          method: 'POST',
          headers: authHeaders(slug),
          body: JSON.stringify({ pmfDisappointment: pmf, painPoint: pain }),
        });
        lastBody = await lastRes.json();
      },
    );

    Then('the feedback POST status is 201', () => {
      expect(lastRes.status).toBe(201);
    });

    And('the feedback response contains a valid id', () => {
      const body = lastBody as { success: boolean; id: string };
      expect(body.success).toBe(true);
      expect(typeof body.id).toBe('string');
      expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    And(
      'a beta_feedback row exists in {string} with pmf_disappointment {string}',
      async (_ctx, slug: string, pmf: string) => {
        const rows = await db
          .select()
          .from(betaFeedback)
          .where(eq(betaFeedback.tenantId, tenantIds[slug]!));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.pmfDisappointment).toBe(pmf);
      },
    );
  });

  Scenario('POST with empty body returns 400', ({ When, Then }) => {
    When('the caller POSTs an empty feedback body to {string}', async (_ctx, slug: string) => {
      lastRes = await app.request('/api/feedback', {
        method: 'POST',
        headers: authHeaders(slug),
        body: JSON.stringify({}),
      });
      lastBody = await lastRes.json();
    });

    Then('the feedback POST status is 400', () => {
      expect(lastRes.status).toBe(400);
    });
  });

  Scenario('Tenant isolation: tenant B cannot read tenant A feedback', ({ Given, When, Then }) => {
    Given(
      'a second feedback tenant {string} exists with the caller as an admin member',
      async (_ctx, slug: string) => {
        const [t] = await db
          .insert(tenants)
          .values({ slug, name: `${slug} Family` })
          .returning();
        tenantIds[slug] = t!.id;
        await db.insert(members).values({
          tenantId: t!.id,
          userId: USER_ID,
          displayName: 'Caller',
          role: 'admin',
        });
      },
    );

    When(
      'the caller POSTs feedback to {string} with pmfDisappointment {string} and painPoint {string}',
      async (_ctx, slug: string, pmf: string, pain: string) => {
        lastRes = await app.request('/api/feedback', {
          method: 'POST',
          headers: authHeaders(slug),
          body: JSON.stringify({ pmfDisappointment: pmf, painPoint: pain }),
        });
        lastBody = await lastRes.json();
      },
    );

    Then('no beta_feedback row exists in {string}', async (_ctx, slug: string) => {
      const rows = await db
        .select()
        .from(betaFeedback)
        .where(eq(betaFeedback.tenantId, tenantIds[slug]!));
      expect(rows).toHaveLength(0);
    });
  });
});
