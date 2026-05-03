import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { onboardingRouter } from '../../../apps/api/src/routes/onboarding.js';
import { tenants, members, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(
  new URL('../features/onboarding.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'onb-int-kid';
const USER_ID = '00000000-0000-4000-8000-00000000aaaa';
const USER_EMAIL = 'admin-int@example.com';

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
  const tenantId = c.req.header('x-test-tenant');
  c.set('tenantId', tenantId);
  await next();
};

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let token: string;
  const tenantIds: Record<string, string> = {};

  Background(({ Given, And }) => {
    Given('the test Postgres has clean tenants, members, and onboarding state', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE pending_invitations RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      _resetJwksCacheForTests();
      for (const k of Object.keys(tenantIds)) delete tenantIds[k];
    });

    And('a users mirror row exists for the test admin', async () => {
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
      app.route('/api/onboarding', onboardingRouter);
      token = await mintToken(privateKey);
    });

    And(
      'tenants {string} and {string} exist with the admin as a member of {string}',
      async (_ctx, slugA: string, slugB: string, adminSlug: string) => {
        for (const slug of [slugA, slugB]) {
          const inserted = await db
            .insert(tenants)
            .values({ slug, name: `${slug} Family` })
            .returning();
          tenantIds[slug] = inserted[0]!.id;
        }
        await db.insert(members).values({
          tenantId: tenantIds[adminSlug]!,
          userId: USER_ID,
          displayName: 'Admin',
          role: 'admin',
        });
      },
    );
  });

  Scenario('Happy path — admin completes onboarding for their tenant', ({ When, Then, And }) => {
    let res: Response;

    When(
      'the admin POSTs onboarding-complete for tenant {string} with timezone {string}, currency {string}, and 2 members',
      async (_ctx, slug: string, timezone: string, currency: string) => {
        res = await app.request('/api/onboarding/complete', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'x-test-tenant': tenantIds[slug]!,
          },
          body: JSON.stringify({
            timezone,
            currency,
            members: [
              { displayName: 'Iman', role: 'child', avatarEmoji: '👧' },
              { displayName: 'Yusuf', role: 'adult' },
            ],
          }),
        });
      },
    );

    Then('the response status is 200', () => {
      expect(res.status).toBe(200);
    });

    And('tenant {string} has onboarding_completed = true', async (_ctx, slug: string) => {
      const { rows } = await db.execute<{ onboarding_completed: boolean }>(
        sql`SELECT onboarding_completed FROM tenants WHERE id = ${tenantIds[slug]!}`,
      );
      expect(rows[0]?.onboarding_completed).toBe(true);
    });

    And('tenant {string} has 3 members in total', async (_ctx, slug: string) => {
      // 1 admin from Background + 2 from the wizard.
      const { rows } = await db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count FROM members WHERE tenant_id = ${tenantIds[slug]!}`,
      );
      expect(Number(rows[0]?.count)).toBe(3);
    });

    And('tenant {string} still has onboarding_completed = false', async (_ctx, slug: string) => {
      const { rows } = await db.execute<{ onboarding_completed: boolean }>(
        sql`SELECT onboarding_completed FROM tenants WHERE id = ${tenantIds[slug]!}`,
      );
      expect(rows[0]?.onboarding_completed).toBe(false);
    });
  });

  Scenario(
    'Idempotent — second submit returns 200 without duplicating members',
    ({ Given, When, Then, And }) => {
      let res: Response;

      Given(
        'the admin has already completed onboarding for tenant {string} with 2 members',
        async (_ctx, slug: string) => {
          await app.request('/api/onboarding/complete', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'x-test-tenant': tenantIds[slug]!,
            },
            body: JSON.stringify({
              timezone: 'Asia/Dubai',
              currency: 'AED',
              members: [
                { displayName: 'Iman', role: 'child', avatarEmoji: '👧' },
                { displayName: 'Yusuf', role: 'adult' },
              ],
            }),
          });
        },
      );

      When(
        'the admin POSTs onboarding-complete for tenant {string} with timezone {string}, currency {string}, and 2 members',
        async (_ctx, slug: string, timezone: string, currency: string) => {
          res = await app.request('/api/onboarding/complete', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'x-test-tenant': tenantIds[slug]!,
            },
            body: JSON.stringify({
              timezone,
              currency,
              members: [
                { displayName: 'Aisha', role: 'adult' },
                { displayName: 'Layla', role: 'teen' },
              ],
            }),
          });
        },
      );

      Then('the response status is 200', () => {
        expect(res.status).toBe(200);
      });

      And('tenant {string} has 3 members in total', async (_ctx, slug: string) => {
        // First submit added 2; idempotent retry must NOT add the
        // second pair. 1 admin + 2 from first call = 3.
        const { rows } = await db.execute<{ count: string }>(
          sql`SELECT COUNT(*)::text AS count FROM members WHERE tenant_id = ${tenantIds[slug]!}`,
        );
        expect(Number(rows[0]?.count)).toBe(3);
      });
    },
  );
});
