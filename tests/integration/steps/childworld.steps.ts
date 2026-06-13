import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { habitsRouter } from '../../../apps/api/src/routes/habits.js';
import { rewardsRouter } from '../../../apps/api/src/routes/rewards.js';
import { tenants, members, habits, rewards, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(
  new URL('../features/childworld.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'childworld-int-kid';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const USER_EMAIL = 'sarah@example.com';

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
  const memberIds: Record<string, string> = {};
  const habitIds: Record<string, string> = {};
  const rewardIds: Record<string, string> = {};

  function headers(slug: string) {
    return { Authorization: `Bearer ${token}`, 'x-test-tenant': tenantIds[slug]! };
  }

  async function logHabit(
    slug: string,
    habitName: string,
    memberName: string,
    date: string,
    done = true,
  ) {
    return app.request(`/api/habits/${habitIds[habitName]!}/log`, {
      method: 'PATCH',
      headers: { ...headers(slug), 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: memberIds[memberName]!, date, done }),
    });
  }

  async function getBalance(slug: string, memberName: string): Promise<number> {
    const res = await app.request(`/api/rewards?memberId=${memberIds[memberName]!}`, {
      method: 'GET',
      headers: headers(slug),
    });
    const body = (await res.json()) as { stickerBalance: number };
    return body.stickerBalance;
  }

  async function seedChild(slug: string, name: string) {
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
  }

  async function seedHabit(slug: string, name: string) {
    const [row] = await db.insert(habits).values({ tenantId: tenantIds[slug]!, name }).returning();
    habitIds[name] = row!.id;
  }

  async function seedReward(slug: string, name: string, cost: number) {
    const [row] = await db
      .insert(rewards)
      .values({ tenantId: tenantIds[slug]!, name, stickerCost: cost })
      .returning();
    rewardIds[name] = row!.id;
  }

  async function seedTenant(slug: string) {
    const [tenant] = await db
      .insert(tenants)
      .values({ slug, name: `${slug} Family` })
      .returning();
    tenantIds[slug] = tenant!.id;
    await db
      .insert(members)
      .values({ tenantId: tenant!.id, userId: USER_ID, displayName: 'Caller', role: 'admin' });
  }

  Background(({ Given, And }) => {
    Given(
      'the test Postgres has clean tenants, members, habits, rewards, and ledger tables',
      async () => {
        db = getTestDb() as unknown as Database;
        await db.execute(sql`TRUNCATE TABLE habit_logs RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE reward_redemptions RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE habits RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE rewards RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
        await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
        _resetJwksCacheForTests();
        for (const m of [tenantIds, memberIds, habitIds, rewardIds]) {
          for (const k of Object.keys(m)) delete m[k];
        }
      },
    );

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
      app.route('/api/habits', habitsRouter);
      app.route('/api/rewards', rewardsRouter);
      token = await mintToken(privateKey);
    });

    And('a tenant {string} exists with the caller as an admin member', async (_c, slug: string) => {
      await seedTenant(slug);
    });
    And(
      'the {string} tenant has a child member {string}',
      async (_c, slug: string, name: string) => {
        await seedChild(slug, name);
      },
    );
    And('the {string} tenant has a habit {string}', async (_c, slug: string, name: string) => {
      await seedHabit(slug, name);
    });
    And(
      'the {string} tenant has a reward {string} costing {int} stickers',
      async (_c, slug: string, name: string, cost: number) => {
        await seedReward(slug, name, cost);
      },
    );
  });

  Scenario('Logging a habit earns a sticker; the balance reflects it', ({ When, Then, And }) => {
    let res: Response;
    When(
      'the caller logs {string} for {string} on {string}',
      async (_c, h: string, m: string, d: string) => {
        res = await logHabit('khan', h, m, d);
      },
    );
    Then('the log response status is 200', () => expect(res.status).toBe(200));
    And(
      '{string} has a sticker balance of {int} in tenant {string}',
      async (_c, m: string, n: number) => {
        expect(await getBalance('khan', m)).toBe(n);
      },
    );
  });

  Scenario('Un-logging a habit removes the sticker', ({ Given, When, Then, And }) => {
    let res: Response;
    Given(
      'the caller logs {string} for {string} on {string}',
      async (_c, h: string, m: string, d: string) => {
        await logHabit('khan', h, m, d);
      },
    );
    When(
      'the caller un-logs {string} for {string} on {string}',
      async (_c, h: string, m: string, d: string) => {
        res = await logHabit('khan', h, m, d, false);
      },
    );
    Then('the log response status is 200', () => expect(res.status).toBe(200));
    And(
      '{string} has a sticker balance of {int} in tenant {string}',
      async (_c, m: string, n: number) => {
        expect(await getBalance('khan', m)).toBe(n);
      },
    );
  });

  Scenario('Redeeming a reward spends stickers', ({ Given, And, When, Then }) => {
    let res: Response;
    Given(
      'the caller logs {string} for {string} on {string}',
      async (_c, h: string, m: string, d: string) => {
        await logHabit('khan', h, m, d);
      },
    );
    And(
      'the caller logs {string} for {string} on {string}',
      async (_c, h: string, m: string, d: string) => {
        await logHabit('khan', h, m, d);
      },
    );
    When(
      'the caller redeems {string} for {string} in tenant {string}',
      async (_c, r: string, m: string, slug: string) => {
        res = await app.request(`/api/rewards/${rewardIds[r]!}/redeem`, {
          method: 'POST',
          headers: { ...headers(slug), 'Content-Type': 'application/json' },
          body: JSON.stringify({ memberId: memberIds[m]! }),
        });
      },
    );
    Then('the redeem response status is 201', () => expect(res.status).toBe(201));
    And(
      '{string} has a sticker balance of {int} in tenant {string}',
      async (_c, m: string, n: number) => {
        expect(await getBalance('khan', m)).toBe(n);
      },
    );
  });

  Scenario('Redeeming without enough stickers is rejected', ({ Given, When, Then }) => {
    let res: Response;
    Given(
      'the caller logs {string} for {string} on {string}',
      async (_c, h: string, m: string, d: string) => {
        await logHabit('khan', h, m, d);
      },
    );
    When(
      'the caller redeems {string} for {string} in tenant {string}',
      async (_c, r: string, m: string, slug: string) => {
        res = await app.request(`/api/rewards/${rewardIds[r]!}/redeem`, {
          method: 'POST',
          headers: { ...headers(slug), 'Content-Type': 'application/json' },
          body: JSON.stringify({ memberId: memberIds[m]! }),
        });
      },
    );
    Then('the redeem response status is 409', () => expect(res.status).toBe(409));
  });

  Scenario(
    "Two concurrent redeems with exactly enough stickers can't double-spend",
    ({ Given, And, When, Then }) => {
      let statuses: number[] = [];
      Given(
        'the caller logs {string} for {string} on {string}',
        async (_c, h: string, m: string, d: string) => {
          await logHabit('khan', h, m, d);
        },
      );
      And(
        'the caller logs {string} for {string} on {string}',
        async (_c, h: string, m: string, d: string) => {
          await logHabit('khan', h, m, d);
        },
      );
      When(
        'the caller fires two redeems of {string} for {string} at once in tenant {string}',
        async (_c, r: string, m: string, slug: string) => {
          const fire = () =>
            app.request(`/api/rewards/${rewardIds[r]!}/redeem`, {
              method: 'POST',
              headers: { ...headers(slug), 'Content-Type': 'application/json' },
              body: JSON.stringify({ memberId: memberIds[m]! }),
            });
          const results = await Promise.all([fire(), fire()]);
          statuses = results.map((res) => res.status);
        },
      );
      Then('exactly one redeem succeeds and one is rejected', () => {
        expect(statuses.filter((s) => s === 201)).toHaveLength(1);
        expect(statuses.filter((s) => s === 409)).toHaveLength(1);
      });
      And(
        '{string} has a sticker balance of {int} in tenant {string}',
        async (_c, m: string, n: number) => {
          expect(await getBalance('khan', m)).toBe(n);
        },
      );
    },
  );

  Scenario(
    "Tenant isolation — another tenant's habit logs never count",
    ({ Given, And, When, Then }) => {
      let res: Response;
      let body: { habits: unknown[]; logs: unknown[] };
      Given(
        'a second tenant {string} exists with the caller as an admin member',
        async (_c, slug: string) => {
          await seedTenant(slug);
        },
      );
      And(
        'the {string} tenant has a child member {string}',
        async (_c, slug: string, name: string) => {
          await seedChild(slug, name);
        },
      );
      And('the {string} tenant has a habit {string}', async (_c, slug: string, name: string) => {
        await seedHabit(slug, name);
      });
      And(
        'the caller logs {string} for {string} on {string} in tenant {string}',
        async (_c, h: string, m: string, d: string, slug: string) => {
          await logHabit(slug, h, m, d);
        },
      );
      When(
        'the caller GETs habits for {string} week {string} in tenant {string}',
        async (_c, m: string, week: string, slug: string) => {
          res = await app.request(`/api/habits?memberId=${memberIds[m]!}&weekStart=${week}`, {
            method: 'GET',
            headers: headers(slug),
          });
          body = (await res.json()) as { habits: unknown[]; logs: unknown[] };
        },
      );
      Then('the habits response status is 200', () => expect(res.status).toBe(200));
      And('the habits response has {int} habits', (_c, n: number) =>
        expect(body.habits).toHaveLength(n),
      );
      And('the habits response has {int} logs', (_c, n: number) =>
        expect(body.logs).toHaveLength(n),
      );
    },
  );
});
