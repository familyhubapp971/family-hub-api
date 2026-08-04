import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { membersRouter } from '../../../apps/api/src/routes/members.js';
import {
  kidPinRouter,
  _resetKidPinBucketsForTests,
} from '../../../apps/api/src/routes/auth-kid-pin.js';
import { tenants, members, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

// FHS-252: integration test for PUT/DELETE /api/members/:id/pin.
// Real Postgres + real JWT + the actual /api/auth/kid-pin endpoint
// mounted alongside, so each scenario can verify a freshly-set PIN
// truly logs the kid in (i.e. round-trips through bcrypt + the
// verify path that ships in FHS-236).

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
  pinRequestTenant: async () => {},
}));

vi.mock('../../../apps/api/src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../apps/api/src/config.js')>(
    '../../../apps/api/src/config.js',
  );
  return {
    ...actual,
    config: {
      ...actual.config,
      KID_AUTH_SECRET: 'a-secret-of-at-least-thirty-two-chars-x',
      KID_PIN_LOCKOUT_MAX_ATTEMPTS: 5,
      KID_PIN_LOCKOUT_MS: 15 * 60_000,
      KID_JWT_TTL_MS: 60 * 60_000,
    },
  };
});

const feature = await loadFeature(
  new URL('../features/members-set-pin.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'members-pin-int-kid';
const ADMIN_USER_ID = '00000000-0000-4000-8000-000000000901';
const ADMIN_USER_EMAIL = 'admin-pin@example.com';
const ADULT_USER_ID = '00000000-0000-4000-8000-000000000902';
const ADULT_USER_EMAIL = 'adult-pin@example.com';

async function genKey() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = 'ES256';
  publicJwk.kid = KID;
  publicJwk.use = 'sig';
  return { privateKey, publicJwk };
}

async function mintToken(privateKey: KeyLike, sub: string, email: string) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setSubject(sub)
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
  let adminToken: string;
  let adultToken: string;
  let privateKey: KeyLike;
  const tenantIds: Record<string, string> = {};
  const memberIds: Record<string, string> = {};

  async function lookupUserSync(userId: string) {
    const rows = await db
      .select()
      .from(users)
      .where(sql`id = ${userId}`)
      .limit(1);
    return rows[0]!;
  }

  Background(({ Given, And }) => {
    Given('the test Postgres has clean tenants, members, and users tables', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${ADMIN_USER_ID}, ${ADULT_USER_ID})`);
      _resetJwksCacheForTests();
      _resetKidPinBucketsForTests();
      for (const k of Object.keys(tenantIds)) delete tenantIds[k];
      for (const k of Object.keys(memberIds)) delete memberIds[k];
    });

    And('a users mirror row exists for the test caller', async () => {
      await db.execute(
        sql`INSERT INTO users (id, email) VALUES (${ADMIN_USER_ID}, ${ADMIN_USER_EMAIL})
            ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      );
      await db.execute(
        sql`INSERT INTO users (id, email) VALUES (${ADULT_USER_ID}, ${ADULT_USER_EMAIL})
            ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      );
      const keys = await genKey();
      privateKey = keys.privateKey;
      app = new Hono();
      app.use(
        '*',
        authMiddleware({
          issuer: ISSUER,
          jwks: makeJwks(keys.publicJwk),
          // Pick the user mirror by id claim so a single app instance
          // can serve both admin + adult tokens.
          userMirrorSync: async (claims) => lookupUserSync(claims.id),
        }),
      );
      app.use('*', resolveTenantFromHeader);
      app.route('/api/members', membersRouter);
      // Mount kid-pin alongside so set-PIN scenarios can verify the
      // hash actually authenticates a kid.
      app.route('/api/auth/kid-pin', kidPinRouter);
      adminToken = await mintToken(privateKey, ADMIN_USER_ID, ADMIN_USER_EMAIL);
      adultToken = await mintToken(privateKey, ADULT_USER_ID, ADULT_USER_EMAIL);
    });

    And(
      'a tenant {string} exists with the caller as an admin member',
      async (_ctx, slug: string) => {
        const [tenant] = await db
          .insert(tenants)
          .values({ slug, name: `${slug} Family` })
          .returning();
        tenantIds[slug] = tenant!.id;
        await db.insert(members).values({
          tenantId: tenant!.id,
          userId: ADMIN_USER_ID,
          displayName: 'Admin Caller',
          role: 'admin',
        });
      },
    );
  });

  async function ensureKidMember(slug: string, name: string, pin: string | null) {
    const tenantId = tenantIds[slug];
    if (!tenantId) throw new Error(`tenant ${slug} not seeded`);
    const pinHash = pin ? await bcrypt.hash(pin, 4) : null;
    const [m] = await db
      .insert(members)
      .values({
        tenantId,
        displayName: name,
        role: 'child',
        isChild: pinHash !== null,
        pinHash,
      })
      .returning();
    memberIds[name] = m!.id;
    return m!;
  }

  async function setPinAs(token: string, slug: string, memberId: string, pin: string) {
    return app.request(`/api/members/${memberId}/pin`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-test-tenant': tenantIds[slug] ?? '',
      },
      body: JSON.stringify({ pin }),
    });
  }

  async function deletePinAs(token: string, slug: string, memberId: string) {
    return app.request(`/api/members/${memberId}/pin`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-test-tenant': tenantIds[slug] ?? '',
      },
    });
  }

  async function verifyKidLogin(slug: string, memberId: string, pin: string) {
    return app.request('/api/auth/kid-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantSlug: slug, memberId, pin }),
    });
  }

  Scenario(
    'Admin sets a fresh PIN on a kid member: verifies via /api/auth/kid-pin',
    ({ Given, When, Then, And }) => {
      let res: Response;
      let body: { member: { isChild: boolean; hasPin: boolean } };

      Given(
        'a kid member {string} exists in tenant {string} with no PIN',
        async (_ctx, name: string, slug: string) => {
          await ensureKidMember(slug, name, null);
        },
      );

      When('the admin PUTs PIN {string} for {string}', async (_ctx, pin: string, name: string) => {
        res = await setPinAs(adminToken, 'khan', memberIds[name]!, pin);
        body = (await res.json()) as typeof body;
      });

      Then('the response status is 200', () => {
        expect(res.status).toBe(200);
      });

      And(
        'the response body marks {string} as isChild {string} and hasPin {string}',
        (_ctx, _name: string, isChild: string, hasPin: string) => {
          expect(body.member.isChild).toBe(isChild === 'true');
          expect(body.member.hasPin).toBe(hasPin === 'true');
        },
      );

      And(
        'kid-login with PIN {string} for {string} succeeds',
        async (_ctx, pin: string, name: string) => {
          const r = await verifyKidLogin('khan', memberIds[name]!, pin);
          expect(r.status).toBe(200);
        },
      );
    },
  );

  Scenario('Admin resets an existing PIN: old PIN stops working', ({ Given, When, Then, And }) => {
    let res: Response;

    Given(
      'a kid member {string} exists in tenant {string} with PIN {string}',
      async (_ctx, name: string, slug: string, pin: string) => {
        await ensureKidMember(slug, name, pin);
      },
    );

    When('the admin PUTs PIN {string} for {string}', async (_ctx, pin: string, name: string) => {
      res = await setPinAs(adminToken, 'khan', memberIds[name]!, pin);
    });

    Then('the response status is 200', () => {
      expect(res.status).toBe(200);
    });

    And(
      'kid-login with PIN {string} for {string} fails',
      async (_ctx, pin: string, name: string) => {
        const r = await verifyKidLogin('khan', memberIds[name]!, pin);
        expect(r.status).toBe(401);
      },
    );

    And(
      'kid-login with PIN {string} for {string} succeeds',
      async (_ctx, pin: string, name: string) => {
        const r = await verifyKidLogin('khan', memberIds[name]!, pin);
        expect(r.status).toBe(200);
      },
    );
  });

  Scenario("Admin DELETEs a kid's PIN: kid is no longer eligible", ({ Given, When, Then, And }) => {
    let res: Response;
    let body: { member: { isChild: boolean; hasPin: boolean } };

    Given(
      'a kid member {string} exists in tenant {string} with PIN {string}',
      async (_ctx, name: string, slug: string, pin: string) => {
        await ensureKidMember(slug, name, pin);
      },
    );

    When('the admin DELETEs the PIN for {string}', async (_ctx, name: string) => {
      res = await deletePinAs(adminToken, 'khan', memberIds[name]!);
      body = (await res.json()) as typeof body;
    });

    Then('the response status is 200', () => {
      expect(res.status).toBe(200);
    });

    And(
      'the response body marks {string} as isChild {string} and hasPin {string}',
      (_ctx, _name: string, isChild: string, hasPin: string) => {
        expect(body.member.isChild).toBe(isChild === 'true');
        expect(body.member.hasPin).toBe(hasPin === 'true');
      },
    );

    And(
      'kid-login with PIN {string} for {string} fails',
      async (_ctx, pin: string, name: string) => {
        const r = await verifyKidLogin('khan', memberIds[name]!, pin);
        expect(r.status).toBe(401);
      },
    );
  });

  Scenario('Adult member can also set a PIN (not just admin)', ({ Given, And, When, Then }) => {
    let res: Response;

    Given(
      'an adult member {string} who is the caller of tenant {string}',
      async (_ctx, name: string, slug: string) => {
        const tenantId = tenantIds[slug];
        if (!tenantId) throw new Error(`tenant ${slug} not seeded`);
        await db.insert(members).values({
          tenantId,
          userId: ADULT_USER_ID,
          displayName: name,
          role: 'adult',
        });
      },
    );

    And(
      'a kid member {string} exists in tenant {string} with no PIN',
      async (_ctx, name: string, slug: string) => {
        await ensureKidMember(slug, name, null);
      },
    );

    When('the adult PUTs PIN {string} for {string}', async (_ctx, pin: string, name: string) => {
      res = await setPinAs(adultToken, 'khan', memberIds[name]!, pin);
    });

    Then('the response status is 200', () => {
      expect(res.status).toBe(200);
    });
  });

  Scenario('Cross-tenant attempt is rejected with 404', ({ Given, When, Then }) => {
    let res: Response;

    Given(
      'a tenant {string} exists with a kid member {string} with PIN {string}',
      async (_ctx, slug: string, name: string, pin: string) => {
        const [tenant] = await db
          .insert(tenants)
          .values({ slug, name: `${slug} Family` })
          .returning();
        tenantIds[slug] = tenant!.id;
        await ensureKidMember(slug, name, pin);
      },
    );

    When(
      'the admin of {string} PUTs PIN {string} for {string}',
      async (_ctx, callerSlug: string, pin: string, name: string) => {
        // Admin is scoped to "khan"; targets a member in "patel" via
        // x-test-tenant=khan but with patel's member id.
        res = await setPinAs(adminToken, callerSlug, memberIds[name]!, pin);
      },
    );

    Then('the response status is 404', () => {
      expect(res.status).toBe(404);
    });
  });

  Scenario('Invalid PIN format is rejected with 400', ({ Given, When, Then }) => {
    let res: Response;

    Given(
      'a kid member {string} exists in tenant {string} with no PIN',
      async (_ctx, name: string, slug: string) => {
        await ensureKidMember(slug, name, null);
      },
    );

    When('the admin PUTs PIN {string} for {string}', async (_ctx, pin: string, name: string) => {
      res = await setPinAs(adminToken, 'khan', memberIds[name]!, pin);
    });

    Then('the response status is 400', () => {
      expect(res.status).toBe(400);
    });
  });

  // FHS-252, defence-in-depth: even if the page UI is bypassed
  // (curl), the API refuses to PIN-flag a non-child/non-teen target.
  Scenario(
    'Setting a PIN on a non-child/non-teen target is rejected with 403',
    ({ Given, When, Then }) => {
      let res: Response;

      Given(
        'an existing adult member {string} of tenant {string}',
        async (_ctx, name: string, slug: string) => {
          const tenantId = tenantIds[slug];
          if (!tenantId) throw new Error(`tenant ${slug} not seeded`);
          const [m] = await db
            .insert(members)
            .values({ tenantId, displayName: name, role: 'adult' })
            .returning();
          memberIds[name] = m!.id;
        },
      );

      When('the admin PUTs PIN {string} for {string}', async (_ctx, pin: string, name: string) => {
        res = await setPinAs(adminToken, 'khan', memberIds[name]!, pin);
      });

      Then('the response status is 403', () => {
        expect(res.status).toBe(403);
      });
    },
  );
});
