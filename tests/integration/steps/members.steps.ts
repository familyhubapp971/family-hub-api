import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { membersRouter } from '../../../apps/api/src/routes/members.js';
import { tenants, members, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

// FHS-108 — integration test for GET /api/members. Real Postgres,
// real JWT, mocked-only at the resolveTenant boundary so each scenario
// can target a specific tenant via the X-Test-Tenant header (mirrors
// the invitations.steps wiring).

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(new URL('../features/members.feature', import.meta.url).pathname);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'members-int-kid';
const USER_ID = '00000000-0000-4000-8000-000000000888';
const USER_EMAIL = 'caller-int@example.com';
const SECOND_USER_ID = '00000000-0000-4000-8000-000000000889';
const SECOND_USER_EMAIL = 'aisha-int@example.com';

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

interface MemberRow {
  id: string;
  displayName: string;
  role: string;
  avatarEmoji: string | null;
  status: 'active' | 'unclaimed';
  createdAt: string;
}

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let token: string;
  const tenantIds: Record<string, string> = {};

  Background(({ Given, And }) => {
    Given('the test Postgres has clean tenants, members, and users tables', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${USER_ID}, ${SECOND_USER_ID})`);
      _resetJwksCacheForTests();
      for (const k of Object.keys(tenantIds)) delete tenantIds[k];
    });

    And('a users mirror row exists for the test caller', async () => {
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
      app.route('/api/members', membersRouter);
      token = await mintToken(privateKey);
    });

    And(
      'a tenant {string} exists with the caller as an admin member',
      async (_ctx, slug: string) => {
        const inserted = await db
          .insert(tenants)
          .values({ slug, name: `${slug} Family` })
          .returning();
        const tenant = inserted[0]!;
        tenantIds[slug] = tenant.id;
        await db.insert(members).values({
          tenantId: tenant.id,
          userId: USER_ID,
          displayName: 'Caller',
          role: 'admin',
        });
      },
    );
  });

  Scenario(
    "Returns every member of the caller's tenant with derived status",
    ({ Given, And, When, Then }) => {
      let res: Response;
      let body: { members: MemberRow[] };

      Given(
        'the {string} tenant has a child member {string} with no linked user',
        async (_ctx, slug: string, name: string) => {
          await db.insert(members).values({
            tenantId: tenantIds[slug]!,
            userId: null,
            displayName: name,
            role: 'child',
          });
        },
      );

      And(
        'the {string} tenant has an adult member {string} linked to a Supabase user',
        async (_ctx, slug: string, name: string) => {
          await db.execute(
            sql`INSERT INTO users (id, email) VALUES (${SECOND_USER_ID}, ${SECOND_USER_EMAIL})
                ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
          );
          await db.insert(members).values({
            tenantId: tenantIds[slug]!,
            userId: SECOND_USER_ID,
            displayName: name,
            role: 'adult',
          });
        },
      );

      When('the caller GETs /api/members for tenant {string}', async (_ctx, slug: string) => {
        res = await app.request('/api/members', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'x-test-tenant': tenantIds[slug]!,
          },
        });
        body = (await res.json()) as { members: MemberRow[] };
      });

      Then('the response status is 200', () => {
        expect(res.status).toBe(200);
      });

      And('the response lists {int} members', (_ctx, count: number) => {
        expect(body.members).toHaveLength(count);
      });

      And('the response contains:', (_ctx, dataTables: Array<Record<string, string>>) => {
        for (const expected of dataTables) {
          const row = body.members.find((m) => m.displayName === expected.name);
          expect(row, `no member named ${expected.name}`).toBeDefined();
          expect(row!.status).toBe(expected.status);
        }
      });
    },
  );

  Scenario('A non-member of the tenant gets 403', ({ Given, When, Then }) => {
    let res: Response;

    Given(
      'a second tenant {string} exists with no caller membership',
      async (_ctx, slug: string) => {
        const inserted = await db
          .insert(tenants)
          .values({ slug, name: `${slug} Family` })
          .returning();
        tenantIds[slug] = inserted[0]!.id;
      },
    );

    When('the caller GETs /api/members for tenant {string}', async (_ctx, slug: string) => {
      res = await app.request('/api/members', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-test-tenant': tenantIds[slug]!,
        },
      });
    });

    Then('the response status is 403', () => {
      expect(res.status).toBe(403);
    });
  });

  Scenario(
    'Tenant isolation — listing one tenant never returns rows from another',
    ({ Given, And, When, Then }) => {
      let res: Response;
      let body: { members: MemberRow[] };

      Given(
        'a second tenant {string} exists with the caller as an admin member',
        async (_ctx, slug: string) => {
          const inserted = await db
            .insert(tenants)
            .values({ slug, name: `${slug} Family` })
            .returning();
          const tenant = inserted[0]!;
          tenantIds[slug] = tenant.id;
          await db.insert(members).values({
            tenantId: tenant.id,
            userId: USER_ID,
            displayName: 'Caller',
            role: 'admin',
          });
        },
      );

      And(
        'the {string} tenant has a child member {string} with no linked user',
        async (_ctx, slug: string, name: string) => {
          await db.insert(members).values({
            tenantId: tenantIds[slug]!,
            userId: null,
            displayName: name,
            role: 'child',
          });
        },
      );

      When('the caller GETs /api/members for tenant {string}', async (_ctx, slug: string) => {
        res = await app.request('/api/members', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'x-test-tenant': tenantIds[slug]!,
          },
        });
        body = (await res.json()) as { members: MemberRow[] };
      });

      Then('the response status is 200', () => {
        expect(res.status).toBe(200);
      });

      And('no member named {string} is in the response', (_ctx, name: string) => {
        expect(body.members.find((m) => m.displayName === name)).toBeUndefined();
      });
    },
  );
});
