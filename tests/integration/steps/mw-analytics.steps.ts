import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { habitsRouter } from '../../../apps/api/src/routes/habits.js';
import { mwWeeksRouter } from '../../../apps/api/src/routes/mw-weeks.js';
import { mwFinancialRouter } from '../../../apps/api/src/routes/mw-financial.js';
import { mwAnalyticsRouter } from '../../../apps/api/src/routes/mw-analytics.js';
import { tenants, members, habits, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(
  new URL('../features/mw-analytics.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'mw-analytics-kid';
const USER_ID = '00000000-0000-4000-8000-0000000007b7';
const USER_EMAIL = 'analytics@example.com';

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

interface WeekStat {
  weekNumber: number;
  totalStickers: number;
  daysCompleted: number;
  completionRate: number;
}
interface HabitStat {
  name: string;
  completedDays: number;
  rate: number;
}

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let token: string;
  const tenantIds: Record<string, string> = {};
  const memberIds: Record<string, string> = {};
  const habitIds: Record<string, string> = {};
  let analytics: { status: number; stickersPerWeek: WeekStat[]; habitStats: HabitStat[] };

  function headers(slug: string) {
    return {
      Authorization: `Bearer ${token}`,
      'x-test-tenant': tenantIds[slug]!,
      'Content-Type': 'application/json',
    };
  }

  async function currentWeekId(memberName: string): Promise<string> {
    const res = await app.request(`/api/mw/weeks/current?memberId=${memberIds[memberName]!}`, {
      headers: headers('khan'),
    });
    const body = (await res.json()) as { week: { id: string } };
    return body.week.id;
  }

  async function placeSticker(habitName: string, memberName: string, day: number) {
    const weekId = await currentWeekId(memberName);
    return app.request(`/api/habits/${habitIds[habitName]!}/stickers`, {
      method: 'POST',
      headers: headers('khan'),
      body: JSON.stringify({ memberId: memberIds[memberName]!, weekId, day, sticker: 'gold-star' }),
    });
  }

  async function invest(habitName: string, memberName: string, count: number) {
    return app.request(`/api/mw/financial/investments`, {
      method: 'POST',
      headers: headers('khan'),
      body: JSON.stringify({
        memberId: memberIds[memberName]!,
        habitId: habitIds[habitName]!,
        stickerCount: count,
      }),
    });
  }

  async function openAnalytics(memberName: string) {
    const res = await app.request(`/api/mw/analytics?memberId=${memberIds[memberName]!}`, {
      headers: headers('khan'),
    });
    const body = (await res.json().catch(() => ({}))) as {
      stickersPerWeek?: WeekStat[];
      habitStats?: HabitStat[];
    };
    analytics = {
      status: res.status,
      stickersPerWeek: body.stickersPerWeek ?? [],
      habitStats: body.habitStats ?? [],
    };
    return analytics;
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

  async function seedHabit(slug: string, name: string, memberName: string, isBonus: boolean) {
    // FHS-512: stickerValue comes from `boost` now; set it explicitly since
    // this direct DB insert bypasses the API's isBonus→boost derivation.
    const [row] = await db
      .insert(habits)
      .values({
        tenantId: tenantIds[slug]!,
        memberId: memberIds[memberName]!,
        name,
        isBonus,
        boost: isBonus ? 5 : 1,
      })
      .returning();
    habitIds[name] = row!.id;
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
    Given('the test Postgres has clean My World analytics tables', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE mw_transaction_stickers RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE mw_savings_transactions RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE mw_week_actions RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE mw_investments RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE mw_savings RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE habit_stickers RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE mw_weeks RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE habits RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
      _resetJwksCacheForTests();
      for (const m of [tenantIds, memberIds, habitIds]) {
        for (const k of Object.keys(m)) delete m[k];
      }
    });

    And('a users mirror row exists for the analytics caller', async () => {
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
      app.route('/api/mw/weeks', mwWeeksRouter);
      app.route('/api/mw/financial', mwFinancialRouter);
      app.route('/api/mw/analytics', mwAnalyticsRouter);
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

    And(
      'the {string} tenant has a habit {string} for {string}',
      async (_c, slug: string, name: string, member: string) => {
        await seedHabit(slug, name, member, false);
      },
    );
  });

  Scenario(
    'The weekly trend and leaderboard reflect placed stickers',
    ({ Given, And, When, Then }) => {
      Given(
        'the caller places a sticker on {string} day {int} for {string}',
        async (_c, h: string, day: number, m: string) => {
          await placeSticker(h, m, day);
        },
      );
      And(
        'the caller places a sticker on {string} day {int} for {string}',
        async (_c, h: string, day: number, m: string) => {
          await placeSticker(h, m, day);
        },
      );
      When('the caller opens analytics for {string}', async (_c, m: string) => {
        await openAnalytics(m);
      });
      Then('the analytics response status is {int}', (_c, n: number) =>
        expect(analytics.status).toBe(n),
      );
      And('the analytics trend has {int} week', (_c, n: number) =>
        expect(analytics.stickersPerWeek.length).toBe(n),
      );
      And('the first analytics week reports {int} potential value', (_c, n: number) =>
        expect(analytics.stickersPerWeek[0]?.totalStickers).toBe(n),
      );
      And('the analytics leaderboard has {int} habit', (_c, n: number) =>
        expect(analytics.habitStats.length).toBe(n),
      );
      And('the top analytics habit has {int} completed days', (_c, n: number) =>
        expect(analytics.habitStats[0]?.completedDays).toBe(n),
      );
    },
  );

  Scenario("An investment doubles that week's potential value", ({ Given, And, When, Then }) => {
    Given(
      'the {string} tenant has a bonus habit {string} for {string}',
      async (_c, slug: string, name: string, member: string) => {
        await seedHabit(slug, name, member, true);
      },
    );
    And(
      'the caller places a sticker on {string} day {int} for {string}',
      async (_c, h: string, day: number, m: string) => {
        await placeSticker(h, m, day);
      },
    );
    And(
      'the caller also places a sticker on {string} day {int} for {string}',
      async (_c, h: string, day: number, m: string) => {
        await placeSticker(h, m, day);
      },
    );
    And(
      'the caller invests {int} stickers in {string} for {string}',
      async (_c, n: number, h: string, m: string) => {
        const res = await invest(h, m, n);
        expect(res.status).toBe(201);
      },
    );
    When('the caller opens analytics for {string}', async (_c, m: string) => {
      await openAnalytics(m);
    });
    Then('the analytics response status is {int}', (_c, n: number) =>
      expect(analytics.status).toBe(n),
    );
    And('the first analytics week reports {int} potential value', (_c, n: number) =>
      expect(analytics.stickersPerWeek[0]?.totalStickers).toBe(n),
    );
  });

  Scenario('Analytics is empty for a child with no habits', ({ Given, When, Then, And }) => {
    Given(
      'the {string} tenant has a child member {string}',
      async (_c, slug: string, name: string) => {
        await seedChild(slug, name);
      },
    );
    When('the caller opens analytics for {string}', async (_c, m: string) => {
      await openAnalytics(m);
    });
    Then('the analytics response status is {int}', (_c, n: number) =>
      expect(analytics.status).toBe(n),
    );
    And('the analytics trend has {int} weeks', (_c, n: number) =>
      expect(analytics.stickersPerWeek.length).toBe(n),
    );
    And('the analytics leaderboard has {int} habits', (_c, n: number) =>
      expect(analytics.habitStats.length).toBe(n),
    );
  });
});
