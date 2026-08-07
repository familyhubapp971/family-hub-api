import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { and, eq, sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { habitsRouter } from '../../../apps/api/src/routes/habits.js';
import { mwWeeksRouter } from '../../../apps/api/src/routes/mw-weeks.js';
import { tenants, members, habits, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(
  new URL('../features/mw-week-scoped-habits.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'mw-week-scoped-habits-kid';
const USER_ID = '00000000-0000-4000-8000-0000000006b6';
const USER_EMAIL = 'weekscopedhabits@example.com';

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
  const closedWeekIds: Record<string, string> = {};
  let lastHabitNames: string[] = [];

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

  async function finalize(memberName: string) {
    const weekId = await currentWeekId(memberName);
    const res = await app.request(`/api/mw/weeks/${weekId}/finalize`, {
      method: 'POST',
      headers: headers('khan'),
      body: JSON.stringify({ memberId: memberIds[memberName]!, continueInvestmentIds: [] }),
    });
    expect(res.status).toBe(200);
    return weekId;
  }

  async function createHabit(name: string, memberName: string) {
    const res = await app.request('/api/habits', {
      method: 'POST',
      headers: headers('khan'),
      body: JSON.stringify({ memberId: memberIds[memberName]!, name }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    habitIds[name] = body.id;
  }

  // The caller here is an admin, and gateStickerDay lets an admin place a
  // sticker on any day of a FINALIZED week (only a non-admin is blocked), so
  // this hits the real POST /:id/stickers route against a closed week's id.
  async function placeStickerInWeek(
    habitName: string,
    memberName: string,
    day: number,
    weekId: string,
  ) {
    const res = await app.request(`/api/habits/${habitIds[habitName]!}/stickers`, {
      method: 'POST',
      headers: headers('khan'),
      body: JSON.stringify({ memberId: memberIds[memberName]!, weekId, day, sticker: 'gold-star' }),
    });
    expect(res.status).toBe(200);
  }

  // No API endpoint sets habits.archivedAt today (DELETE hard-deletes the
  // row instead), so this seeds the state directly against real Postgres,
  // the way "Ali has an earlier open week from 2020" seeds state elsewhere.
  async function archiveHabit(name: string, memberName: string) {
    await db
      .update(habits)
      .set({ archivedAt: new Date() })
      .where(and(eq(habits.id, habitIds[name]!), eq(habits.memberId, memberIds[memberName]!)));
  }

  async function habitNames(memberName: string, weekId?: string): Promise<string[]> {
    const qs = weekId
      ? `memberId=${memberIds[memberName]!}&weekId=${weekId}`
      : `memberId=${memberIds[memberName]!}`;
    const res = await app.request(`/api/habits?${qs}`, { headers: headers('khan') });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { habits: { name: string }[] };
    return body.habits.map((h) => h.name);
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

  async function seedHabit(slug: string, name: string, memberName: string) {
    const [row] = await db
      .insert(habits)
      .values({ tenantId: tenantIds[slug]!, memberId: memberIds[memberName]!, name })
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
    Given('the test Postgres has clean My World tables', async () => {
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
      for (const m of [tenantIds, memberIds, habitIds, closedWeekIds]) {
        for (const k of Object.keys(m)) delete m[k];
      }
      lastHabitNames = [];
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
      app.route('/api/habits', habitsRouter);
      app.route('/api/mw/weeks', mwWeeksRouter);
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
        await seedHabit(slug, name, member);
      },
    );
  });

  Scenario(
    'A habit created after a week closes does not appear in that week',
    ({ Given, And, When, Then }) => {
      Given('the caller closes the current week for {string}', async (_c, m: string) => {
        closedWeekIds[m] = await finalize(m);
      });
      And('the caller creates a habit {string} for {string}', async (_c, h: string, m: string) => {
        await createHabit(h, m);
      });
      When('the caller views habits for {string} in the closed week', async (_c, m: string) => {
        lastHabitNames = await habitNames(m, closedWeekIds[m]!);
      });
      Then('the habit list includes {string}', (_c, name: string) =>
        expect(lastHabitNames).toContain(name),
      );
      And('the habit list does not include {string}', (_c, name: string) =>
        expect(lastHabitNames).not.toContain(name),
      );
    },
  );

  Scenario(
    'A habit archived after a week closes still appears in that week',
    ({ Given, And, When, Then }) => {
      Given('the caller closes the current week for {string}', async (_c, m: string) => {
        closedWeekIds[m] = await finalize(m);
      });
      And(
        'the caller archives the habit {string} for {string}',
        async (_c, h: string, m: string) => {
          await archiveHabit(h, m);
        },
      );
      When('the caller views habits for {string} in the closed week', async (_c, m: string) => {
        lastHabitNames = await habitNames(m, closedWeekIds[m]!);
      });
      Then('the habit list includes {string}', (_c, name: string) =>
        expect(lastHabitNames).toContain(name),
      );
    },
  );

  Scenario(
    'The live week reflects a new habit and an archived habit immediately',
    ({ Given, And, When, Then }) => {
      Given(
        'the caller creates a habit {string} for {string}',
        async (_c, h: string, m: string) => {
          await createHabit(h, m);
        },
      );
      And(
        'the caller archives the habit {string} for {string}',
        async (_c, h: string, m: string) => {
          await archiveHabit(h, m);
        },
      );
      When('the caller views habits for {string} in the current week', async (_c, m: string) => {
        lastHabitNames = await habitNames(m);
      });
      Then('the habit list includes {string}', (_c, name: string) =>
        expect(lastHabitNames).toContain(name),
      );
      And('the habit list does not include {string}', (_c, name: string) =>
        expect(lastHabitNames).not.toContain(name),
      );
    },
  );

  Scenario(
    'A habit whose sticker is recorded for a closed week still appears, even with a late createdAt',
    ({ Given, And, When, Then }) => {
      Given('the caller closes the current week for {string}', async (_c, m: string) => {
        closedWeekIds[m] = await finalize(m);
      });
      And('the caller creates a habit {string} for {string}', async (_c, h: string, m: string) => {
        await createHabit(h, m);
      });
      And(
        'the caller places a sticker on {string} day {int} for {string} in the closed week',
        async (_c, h: string, day: number, m: string) => {
          await placeStickerInWeek(h, m, day, closedWeekIds[m]!);
        },
      );
      When('the caller views habits for {string} in the closed week', async (_c, m: string) => {
        lastHabitNames = await habitNames(m, closedWeekIds[m]!);
      });
      Then('the habit list includes {string}', (_c, name: string) =>
        expect(lastHabitNames).toContain(name),
      );
    },
  );
});
