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
  const lastChildByTenant: Record<string, string> = {};
  const rewardIds: Record<string, string> = {};

  function headers(slug: string) {
    return { Authorization: `Bearer ${token}`, 'x-test-tenant': tenantIds[slug]! };
  }

  const weekCache: Record<string, string> = {};

  async function currentWeekId(slug: string, memberName: string): Promise<string> {
    const cacheKey = `${slug}:${memberName}`;
    if (weekCache[cacheKey]) return weekCache[cacheKey]!;
    const res = await app.request(`/api/habits?memberId=${memberIds[memberName]!}`, {
      method: 'GET',
      headers: headers(slug),
    });
    const body = (await res.json()) as { week: { id: string } };
    weekCache[cacheKey] = body.week.id;
    return body.week.id;
  }

  async function placeSticker(slug: string, habitName: string, memberName: string, day: number) {
    const weekId = await currentWeekId(slug, memberName);
    return app.request(`/api/habits/${habitIds[habitName]!}/stickers`, {
      method: 'POST',
      headers: { ...headers(slug), 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: memberIds[memberName]!, weekId, day, sticker: 'gold-star' }),
    });
  }

  async function removeSticker(slug: string, habitName: string, memberName: string, day: number) {
    const weekId = await currentWeekId(slug, memberName);
    return app.request(`/api/habits/${habitIds[habitName]!}/stickers`, {
      method: 'DELETE',
      headers: { ...headers(slug), 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: memberIds[memberName]!, weekId, day }),
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
    lastChildByTenant[slug] = row!.id; // habits seeded next belong to this child
  }

  async function seedHabit(slug: string, name: string, isBonus = false) {
    // FHS-512 — stickerValue comes from `boost` now; set it explicitly since
    // this direct DB insert bypasses the API's isBonus→boost derivation.
    const [row] = await db
      .insert(habits)
      .values({
        tenantId: tenantIds[slug]!,
        memberId: lastChildByTenant[slug]!,
        name,
        isBonus,
        boost: isBonus ? 5 : 1,
      })
      .returning();
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
        await db.execute(sql`TRUNCATE TABLE habit_stickers RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE mw_weeks RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE reward_redemptions RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE habits RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE rewards RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
        await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
        _resetJwksCacheForTests();
        for (const m of [tenantIds, memberIds, habitIds, rewardIds, weekCache]) {
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

  Scenario('Placing a sticker earns it; the balance reflects it', ({ When, Then, And }) => {
    let res: Response;
    When(
      'the caller places a sticker on {string} day {int} for {string}',
      async (_c, h: string, day: number, m: string) => {
        res = await placeSticker('khan', h, m, day);
      },
    );
    Then('the sticker response status is {int}', (_c, n: number) => expect(res.status).toBe(n));
    And(
      '{string} has a sticker balance of {int} in tenant {string}',
      async (_c, m: string, n: number) => {
        expect(await getBalance('khan', m)).toBe(n);
      },
    );
  });

  Scenario('Removing a sticker drops the balance', ({ Given, When, Then, And }) => {
    let res: Response;
    Given(
      'the caller places a sticker on {string} day {int} for {string}',
      async (_c, h: string, day: number, m: string) => {
        await placeSticker('khan', h, m, day);
      },
    );
    When(
      'the caller removes the sticker on {string} day {int} for {string}',
      async (_c, h: string, day: number, m: string) => {
        res = await removeSticker('khan', h, m, day);
      },
    );
    Then('the sticker response status is {int}', (_c, n: number) => expect(res.status).toBe(n));
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
      'the caller places a sticker on {string} day {int} for {string}',
      async (_c, h: string, day: number, m: string) => {
        await placeSticker('khan', h, m, day);
      },
    );
    And(
      'the caller also places a sticker on {string} day {int} for {string}',
      async (_c, h: string, day: number, m: string) => {
        await placeSticker('khan', h, m, day);
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
      'the caller places a sticker on {string} day {int} for {string}',
      async (_c, h: string, day: number, m: string) => {
        await placeSticker('khan', h, m, day);
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
        'the caller places a sticker on {string} day {int} for {string}',
        async (_c, h: string, day: number, m: string) => {
          await placeSticker('khan', h, m, day);
        },
      );
      And(
        'the caller also places a sticker on {string} day {int} for {string}',
        async (_c, h: string, day: number, m: string) => {
          await placeSticker('khan', h, m, day);
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
    'Each child earns on their own habit; cross-child placement is rejected',
    ({ Given, And, Then }) => {
      Given(
        'the {string} tenant has a child member {string}',
        async (_c, slug: string, name: string) => {
          await seedChild(slug, name);
        },
      );
      And('the {string} tenant has a habit {string}', async (_c, slug: string, name: string) => {
        await seedHabit(slug, name);
      });
      And(
        'the caller places a sticker on {string} day {int} for {string}',
        async (_c, h: string, day: number, m: string) => {
          await placeSticker('khan', h, m, day);
        },
      );
      And(
        'the caller also places a sticker on {string} day {int} for {string}',
        async (_c, h: string, day: number, m: string) => {
          await placeSticker('khan', h, m, day);
        },
      );
      Then(
        '{string} has a sticker balance of {int} in tenant {string}',
        async (_c, m: string, n: number) => {
          expect(await getBalance('khan', m)).toBe(n);
        },
      );
      And(
        '{string} has a sticker balance of {int} in tenant {string}',
        async (_c, m: string, n: number) => {
          expect(await getBalance('khan', m)).toBe(n);
        },
      );
      And(
        'placing a sticker on {string} day {int} for {string} is rejected with 404',
        async (_c, h: string, day: number, m: string) => {
          const res = await placeSticker('khan', h, m, day);
          expect(res.status).toBe(404);
        },
      );
    },
  );

  Scenario('Bonus habit earns 5 stickers per day', ({ Given, When, Then, And }) => {
    let res: Response;
    Given(
      'the {string} tenant has a bonus habit {string}',
      async (_c, slug: string, name: string) => {
        await seedHabit(slug, name, true);
      },
    );
    When(
      'the caller places a sticker on {string} day {int} for {string}',
      async (_c, h: string, day: number, m: string) => {
        res = await placeSticker('khan', h, m, day);
      },
    );
    Then('the sticker response status is {int}', (_c, n: number) => expect(res.status).toBe(n));
    And(
      '{string} has a sticker balance of {int} in tenant {string}',
      async (_c, m: string, n: number) => {
        expect(await getBalance('khan', m)).toBe(n);
      },
    );
  });

  Scenario(
    "Tenant isolation — another tenant's stickers never count",
    ({ Given, And, When, Then }) => {
      let res: Response;
      let body: { habits: unknown[]; stickers: unknown[] };
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
        'the caller places a sticker on {string} day {int} for {string} in tenant {string}',
        async (_c, h: string, day: number, m: string, slug: string) => {
          await placeSticker(slug, h, m, day);
        },
      );
      When(
        'the caller GETs habits for {string} in tenant {string}',
        async (_c, m: string, slug: string) => {
          res = await app.request(`/api/habits?memberId=${memberIds[m]!}`, {
            method: 'GET',
            headers: headers(slug),
          });
          body = (await res.json()) as { habits: unknown[]; stickers: unknown[] };
        },
      );
      Then('the habits response status is 200', () => expect(res.status).toBe(200));
      And('the habits response has {int} habits', (_c, n: number) =>
        expect(body.habits).toHaveLength(n),
      );
      And('the habits response has {int} stickers', (_c, n: number) =>
        expect(body.stickers).toHaveLength(n),
      );
    },
  );

  Scenario('Each child sees only their own habits (multi-child)', ({ Given, And, When, Then }) => {
    let res: Response;
    let body: { habits: unknown[]; stickers: unknown[] };
    Given(
      'the {string} tenant has a child member {string}',
      async (_c, slug: string, name: string) => {
        await seedChild(slug, name);
      },
    );
    And('the {string} tenant has a habit {string}', async (_c, slug: string, name: string) => {
      await seedHabit(slug, name);
    });
    When(
      'the caller GETs habits for {string} in tenant {string}',
      async (_c, m: string, slug: string) => {
        res = await app.request(`/api/habits?memberId=${memberIds[m]!}`, {
          method: 'GET',
          headers: headers(slug),
        });
        body = (await res.json()) as { habits: unknown[]; stickers: unknown[] };
      },
    );
    Then('the habits response status is 200', () => expect(res.status).toBe(200));
    And('the habits response has {int} habits', (_c, n: number) =>
      expect(body.habits).toHaveLength(n),
    );
  });
});
