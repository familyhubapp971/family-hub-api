import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { and, eq, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { onboardingRouter } from '../../../apps/api/src/routes/onboarding.js';
import { tenants, members, habits, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

// FHS-634: the dashboard setup guide, read from real data against real
// Postgres. The bug this pins: state used to live in localStorage, so the
// answers changed with the browser rather than with the family.

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
  pinRequestTenant: async () => {},
}));

const feature = await loadFeature(
  new URL('../features/get-started.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'get-started-int-kid';
const ADMIN_USER_ID = '00000000-0000-4000-8000-000000000931';
const ADMIN_USER_EMAIL = 'admin-gs@example.com';
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000932';
const OTHER_USER_EMAIL = 'other-gs@example.com';

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
  c.set('tenantId', c.req.header('x-test-tenant'));
  await next();
};

interface StepsBody {
  dismissed: boolean;
  steps: { kids: boolean; pins: boolean; rate: boolean; habits: boolean };
  firstKidId: string | null;
}

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let privateKey: KeyLike;
  let adminToken: string;
  let otherToken: string;
  let res: Response;
  let body: StepsBody;
  let firstDismissedAt: Date | null = null;
  const tenantIds: Record<string, string> = {};

  async function lookupUserSync(userId: string) {
    const rows = await db
      .select()
      .from(users)
      .where(sql`id = ${userId}`)
      .limit(1);
    return rows[0]!;
  }

  function readGuide(token: string, slug: string) {
    return app.request('/api/onboarding/get-started', {
      headers: { Authorization: `Bearer ${token}`, 'x-test-tenant': tenantIds[slug] ?? '' },
    });
  }

  function dismissGuide(token: string, slug: string) {
    return app.request('/api/onboarding/get-started/dismiss', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'x-test-tenant': tenantIds[slug] ?? '' },
    });
  }

  async function dismissedAtFor(userId: string, slug: string) {
    const rows = await db
      .select({ at: members.getStartedDismissedAt })
      .from(members)
      .where(and(eq(members.tenantId, tenantIds[slug]!), eq(members.userId, userId)))
      .limit(1);
    return rows[0]?.at ?? null;
  }

  async function addKid(slug: string, name: string, pin: string | null) {
    const pinHash = pin ? await bcrypt.hash(pin, 4) : null;
    const [m] = await db
      .insert(members)
      .values({
        tenantId: tenantIds[slug]!,
        displayName: name,
        role: 'child',
        isChild: pinHash !== null,
        pinHash,
      })
      .returning();
    return m!;
  }

  Background(({ Given, And }) => {
    Given('the test Postgres has clean tenants, members, habits, and users tables', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE habits RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${ADMIN_USER_ID}, ${OTHER_USER_ID})`);
      _resetJwksCacheForTests();
      for (const k of Object.keys(tenantIds)) delete tenantIds[k];
      firstDismissedAt = null;
    });

    And('a users mirror row exists for the test caller', async () => {
      await db.execute(
        sql`INSERT INTO users (id, email) VALUES (${ADMIN_USER_ID}, ${ADMIN_USER_EMAIL})
            ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      );
      await db.execute(
        sql`INSERT INTO users (id, email) VALUES (${OTHER_USER_ID}, ${OTHER_USER_EMAIL})
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
          userMirrorSync: async (claims) => lookupUserSync(claims.id),
        }),
      );
      app.use('*', resolveTenantFromHeader);
      app.route('/api/onboarding', onboardingRouter);
      adminToken = await mintToken(privateKey, ADMIN_USER_ID, ADMIN_USER_EMAIL);
      otherToken = await mintToken(privateKey, OTHER_USER_ID, OTHER_USER_EMAIL);
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

  Scenario('A brand-new family has none of the four steps done', ({ When, Then, And }) => {
    When('the admin reads the setup guide for {string}', async (_ctx, slug: string) => {
      res = await readGuide(adminToken, slug);
      body = (await res.json()) as StepsBody;
    });
    Then('the response status is {number}', (_ctx, status: number) => {
      expect(res.status).toBe(status);
    });
    And(
      'the steps are kids {string}, pins {string}, rate {string}, habits {string}',
      (_ctx, kids: string, pins: string, rate: string, habitsDone: string) => {
        expect(body.steps).toEqual({
          kids: kids === 'true',
          pins: pins === 'true',
          rate: rate === 'true',
          habits: habitsDone === 'true',
        });
      },
    );
    And('the guide is not dismissed', () => {
      expect(body.dismissed).toBe(false);
    });
  });

  Scenario(
    'Steps tick from what the family actually has, not what was tapped',
    ({ Given, And, When, Then }) => {
      Given(
        'a kid member {string} exists in tenant {string} with a PIN',
        async (_ctx, name: string, slug: string) => {
          const kid = await addKid(slug, name, '1234');
          expect(kid.pinHash).not.toBeNull();
        },
      );
      And(
        '{string} has a habit of their own in tenant {string}',
        async (_ctx, name: string, slug: string) => {
          const [kid] = await db
            .select({ id: members.id })
            .from(members)
            .where(and(eq(members.tenantId, tenantIds[slug]!), eq(members.displayName, name)))
            .limit(1);
          await db
            .insert(habits)
            .values({ tenantId: tenantIds[slug]!, memberId: kid!.id, name: 'Read' });
        },
      );
      And('tenant {string} has chosen its sticker rate', async (_ctx, slug: string) => {
        await db
          .update(tenants)
          .set({ stickerRateSetAt: new Date() })
          .where(eq(tenants.id, tenantIds[slug]!));
      });
      When('the admin reads the setup guide for {string}', async (_ctx, slug: string) => {
        res = await readGuide(adminToken, slug);
        body = (await res.json()) as StepsBody;
      });
      Then('the response status is {number}', (_ctx, status: number) => {
        expect(res.status).toBe(status);
      });
      And(
        'the steps are kids {string}, pins {string}, rate {string}, habits {string}',
        (_ctx, kids: string, pins: string, rate: string, habitsDone: string) => {
          expect(body.steps).toEqual({
            kids: kids === 'true',
            pins: pins === 'true',
            rate: rate === 'true',
            habits: habitsDone === 'true',
          });
        },
      );
    },
  );

  Scenario(
    'The starter habits seeded at sign-up do not count as picking habits',
    ({ Given, And, When, Then }) => {
      Given(
        'a kid member {string} exists in tenant {string} with a PIN',
        async (_ctx, name: string, slug: string) => {
          await addKid(slug, name, '1234');
        },
      );
      And(
        'tenant {string} has a family-level starter habit with no owner',
        async (_ctx, slug: string) => {
          await db
            .insert(habits)
            .values({ tenantId: tenantIds[slug]!, memberId: null, name: 'Tidy room' });
        },
      );
      When('the admin reads the setup guide for {string}', async (_ctx, slug: string) => {
        res = await readGuide(adminToken, slug);
        body = (await res.json()) as StepsBody;
      });
      Then(
        'the steps are kids {string}, pins {string}, rate {string}, habits {string}',
        (_ctx, kids: string, pins: string, rate: string, habitsDone: string) => {
          expect(body.steps).toEqual({
            kids: kids === 'true',
            pins: pins === 'true',
            rate: rate === 'true',
            habits: habitsDone === 'true',
          });
        },
      );
    },
  );

  Scenario(
    'A family that already changed its sticker rate is not asked again',
    ({ Given, And, When, Then }) => {
      Given(
        'a kid member {string} exists in tenant {string} with a PIN',
        async (_ctx, name: string, slug: string) => {
          await addKid(slug, name, '1234');
        },
      );
      And(
        'tenant {string} runs on a sticker rate of {number} with no record of when it was set',
        async (_ctx, slug: string, rate: number) => {
          // Exactly the shape every pre-FHS-634 family is in after the
          // migration: a real chosen rate, and a null timestamp.
          await db
            .update(tenants)
            .set({ stickerRateMinor: rate, stickerRateSetAt: null })
            .where(eq(tenants.id, tenantIds[slug]!));
        },
      );
      When('the admin reads the setup guide for {string}', async (_ctx, slug: string) => {
        res = await readGuide(adminToken, slug);
        body = (await res.json()) as StepsBody;
      });
      Then(
        'the steps are kids {string}, pins {string}, rate {string}, habits {string}',
        (_ctx, kids: string, pins: string, rate: string, habitsDone: string) => {
          expect(body.steps).toEqual({
            kids: kids === 'true',
            pins: pins === 'true',
            rate: rate === 'true',
            habits: habitsDone === 'true',
          });
        },
      );
    },
  );

  Scenario("A child's own rate override also counts as choosing", ({ Given, And, When, Then }) => {
    Given(
      'a kid member {string} exists in tenant {string} with a PIN',
      async (_ctx, name: string, slug: string) => {
        await addKid(slug, name, '1234');
      },
    );
    And(
      '{string} has their own sticker rate of {number}',
      async (_ctx, name: string, rate: number) => {
        await db
          .update(members)
          .set({ stickerRateMinor: rate })
          .where(and(eq(members.tenantId, tenantIds['khan']!), eq(members.displayName, name)));
      },
    );
    When('the admin reads the setup guide for {string}', async (_ctx, slug: string) => {
      res = await readGuide(adminToken, slug);
      body = (await res.json()) as StepsBody;
    });
    Then(
      'the steps are kids {string}, pins {string}, rate {string}, habits {string}',
      (_ctx, kids: string, pins: string, rate: string, habitsDone: string) => {
        expect(body.steps).toEqual({
          kids: kids === 'true',
          pins: pins === 'true',
          rate: rate === 'true',
          habits: habitsDone === 'true',
        });
      },
    );
  });

  Scenario('An archived habit does not count as picking a habit', ({ Given, And, When, Then }) => {
    Given(
      'a kid member {string} exists in tenant {string} with a PIN',
      async (_ctx, name: string, slug: string) => {
        await addKid(slug, name, '1234');
      },
    );
    And(
      '{string} has a habit of their own in tenant {string}',
      async (_ctx, name: string, slug: string) => {
        const [kid] = await db
          .select({ id: members.id })
          .from(members)
          .where(and(eq(members.tenantId, tenantIds[slug]!), eq(members.displayName, name)))
          .limit(1);
        await db
          .insert(habits)
          .values({ tenantId: tenantIds[slug]!, memberId: kid!.id, name: 'Read' });
      },
    );
    And('every habit in tenant {string} is archived', async (_ctx, slug: string) => {
      await db
        .update(habits)
        .set({ archivedAt: new Date() })
        .where(eq(habits.tenantId, tenantIds[slug]!));
    });
    When('the admin reads the setup guide for {string}', async (_ctx, slug: string) => {
      res = await readGuide(adminToken, slug);
      body = (await res.json()) as StepsBody;
    });
    Then(
      'the steps are kids {string}, pins {string}, rate {string}, habits {string}',
      (_ctx, kids: string, pins: string, rate: string, habitsDone: string) => {
        expect(body.steps).toEqual({
          kids: kids === 'true',
          pins: pins === 'true',
          rate: rate === 'true',
          habits: habitsDone === 'true',
        });
      },
    );
  });

  Scenario('A teen counts as a kid', ({ Given, When, Then }) => {
    Given(
      'a teen member {string} exists in tenant {string} with a PIN',
      async (_ctx, name: string, slug: string) => {
        // FHS-569's lesson: a teen-only family was once told it had no kids.
        const pinHash = await bcrypt.hash('4321', 4);
        await db.insert(members).values({
          tenantId: tenantIds[slug]!,
          displayName: name,
          role: 'teen',
          isChild: true,
          pinHash,
        });
      },
    );
    When('the admin reads the setup guide for {string}', async (_ctx, slug: string) => {
      res = await readGuide(adminToken, slug);
      body = (await res.json()) as StepsBody;
    });
    Then(
      'the steps are kids {string}, pins {string}, rate {string}, habits {string}',
      (_ctx, kids: string, pins: string, rate: string, habitsDone: string) => {
        expect(body.steps).toEqual({
          kids: kids === 'true',
          pins: pins === 'true',
          rate: rate === 'true',
          habits: habitsDone === 'true',
        });
      },
    );
  });

  Scenario('The PIN step waits until every kid has one', ({ Given, And, When, Then }) => {
    Given(
      'a kid member {string} exists in tenant {string} with a PIN',
      async (_ctx, name: string, slug: string) => {
        await addKid(slug, name, '1234');
      },
    );
    And(
      'a kid member {string} exists in tenant {string} with no PIN',
      async (_ctx, name: string, slug: string) => {
        await addKid(slug, name, null);
      },
    );
    When('the admin reads the setup guide for {string}', async (_ctx, slug: string) => {
      res = await readGuide(adminToken, slug);
      body = (await res.json()) as StepsBody;
    });
    Then(
      'the steps are kids {string}, pins {string}, rate {string}, habits {string}',
      (_ctx, kids: string, pins: string, rate: string, habitsDone: string) => {
        expect(body.steps).toEqual({
          kids: kids === 'true',
          pins: pins === 'true',
          rate: rate === 'true',
          habits: habitsDone === 'true',
        });
      },
    );
  });

  Scenario('Hiding the guide sticks for that parent on the next request', ({ When, Then, And }) => {
    When('the admin dismisses the setup guide for {string}', async (_ctx, slug: string) => {
      res = await dismissGuide(adminToken, slug);
    });
    Then('the response status is {number}', (_ctx, status: number) => {
      expect(res.status).toBe(status);
    });
    And(
      'reading the setup guide for {string} as the admin says it is dismissed',
      async (_ctx, slug: string) => {
        const read = await readGuide(adminToken, slug);
        expect(((await read.json()) as StepsBody).dismissed).toBe(true);
      },
    );
  });

  Scenario(
    'Dismissing twice is not an error and keeps the first timestamp',
    ({ When, And, Then }) => {
      When('the admin dismisses the setup guide for {string}', async (_ctx, slug: string) => {
        res = await dismissGuide(adminToken, slug);
        firstDismissedAt = await dismissedAtFor(ADMIN_USER_ID, slug);
        expect(firstDismissedAt).not.toBeNull();
      });
      And('the admin dismisses the setup guide for {string} again', async (_ctx, slug: string) => {
        res = await dismissGuide(adminToken, slug);
        expect(await dismissedAtFor(ADMIN_USER_ID, slug)).toEqual(firstDismissedAt);
      });
      Then('the response status is {number}', (_ctx, status: number) => {
        expect(res.status).toBe(status);
      });
      And('the recorded dismissal time did not move', async () => {
        expect(await dismissedAtFor(ADMIN_USER_ID, 'khan')).toEqual(firstDismissedAt);
      });
    },
  );

  Scenario(
    'One parent hiding it does not hide it for the other parent',
    ({ Given, When, Then }) => {
      Given(
        'a second admin {string} of tenant {string}',
        async (_ctx, name: string, slug: string) => {
          await db.insert(members).values({
            tenantId: tenantIds[slug]!,
            userId: OTHER_USER_ID,
            displayName: name,
            role: 'admin',
          });
        },
      );
      When('the admin dismisses the setup guide for {string}', async (_ctx, slug: string) => {
        res = await dismissGuide(adminToken, slug);
        expect(res.status).toBe(200);
      });
      Then(
        'reading the setup guide for {string} as {string} says it is not dismissed',
        async (_ctx, slug: string) => {
          const read = await readGuide(otherToken, slug);
          expect(read.status).toBe(200);
          expect(((await read.json()) as StepsBody).dismissed).toBe(false);
        },
      );
    },
  );

  Scenario('A non-admin member is refused', ({ Given, When, Then }) => {
    Given(
      'an adult member {string} who is the caller of tenant {string}',
      async (_ctx, name: string, slug: string) => {
        await db.insert(members).values({
          tenantId: tenantIds[slug]!,
          userId: OTHER_USER_ID,
          displayName: name,
          role: 'adult',
        });
      },
    );
    When('the adult reads the setup guide for {string}', async (_ctx, slug: string) => {
      res = await readGuide(otherToken, slug);
    });
    Then('the response status is {number}', (_ctx, status: number) => {
      expect(res.status).toBe(status);
    });
  });

  Scenario(
    "Tenant isolation: another family's setup never ticks these steps",
    ({ Given, When, Then }) => {
      Given(
        'a tenant {string} exists with a kid with a PIN, a habit and a chosen rate',
        async (_ctx, slug: string) => {
          const [tenant] = await db
            .insert(tenants)
            .values({ slug, name: `${slug} Family`, stickerRateSetAt: new Date() })
            .returning();
          tenantIds[slug] = tenant!.id;
          const kid = await addKid(slug, 'Riya', '1111');
          await db
            .insert(habits)
            .values({ tenantId: tenant!.id, memberId: kid.id, name: 'Practice piano' });
        },
      );
      When('the admin reads the setup guide for {string}', async (_ctx, slug: string) => {
        res = await readGuide(adminToken, slug);
        body = (await res.json()) as StepsBody;
      });
      Then(
        'the steps are kids {string}, pins {string}, rate {string}, habits {string}',
        (_ctx, kids: string, pins: string, rate: string, habitsDone: string) => {
          expect(body.steps).toEqual({
            kids: kids === 'true',
            pins: pins === 'true',
            rate: rate === 'true',
            habits: habitsDone === 'true',
          });
        },
      );
    },
  );
});
