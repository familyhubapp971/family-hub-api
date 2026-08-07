/**
 * Step bindings for mw-savings-split.feature (FHS-606).
 *
 * Real Postgres on :5433, proves the Your Savings split: freshly banked
 * stickers read as "earned last week", an untouched balance reads entirely
 * as "kept from earlier", the two lines always sum to the sticker total, and
 * one tenant can never read another tenant's split. Mirrors the auth + seed
 * scaffold of mw-investment-deductible.steps.ts.
 */

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
import { tenants, members, habits, mwSavings, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(
  new URL('../features/mw-savings-split.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'mw-savings-split-kid';
const USER_ID = '00000000-0000-4000-8000-0000000006a6';
const USER_EMAIL = 'savings-split@example.com';

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

interface SavingsBody {
  savedStickers: number;
  earnedLastWeekStickers: number;
  keptFromEarlierStickers: number;
}

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let token: string;
  const tenantIds: Record<string, string> = {};
  const memberIds: Record<string, string> = {};
  const habitIds: Record<string, string> = {};
  let lastSavings: SavingsBody;

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

  async function fetchSavings(memberName: string, slug: string) {
    const res = await app.request(`/api/mw/financial/savings?memberId=${memberIds[memberName]!}`, {
      headers: headers(slug),
    });
    expect(res.status).toBe(200);
    lastSavings = (await res.json()) as SavingsBody;
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
    // A pre-existing balance with no ledger rows: everything the child kept
    // from before this test began.
    await db.insert(mwSavings).values({
      tenantId: tenantIds[slug]!,
      memberId: row!.id,
      savedStickers: 50,
      savedCash: '0',
    });
  }

  async function seedHabit(slug: string, name: string, memberName: string) {
    const [row] = await db
      .insert(habits)
      .values({ tenantId: tenantIds[slug]!, memberId: memberIds[memberName]!, name })
      .returning();
    habitIds[name] = row!.id;
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
      for (const m of [tenantIds, memberIds, habitIds]) {
        for (const k of Object.keys(m)) delete m[k];
      }
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
      app.route('/api/mw/financial', mwFinancialRouter);
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
      async (_c, slug: string, name: string, memberName: string) => {
        await seedHabit(slug, name, memberName);
      },
    );
  });

  Scenario('freshly banked stickers read as earned last week', ({ Given, And, When, Then }) => {
    Given(
      'the caller places a sticker on {string} day {int} for {string}',
      async (_c, habitName: string, day: number, memberName: string) => {
        const res = await placeSticker(habitName, memberName, day);
        expect(res.status).toBe(200);
      },
    );
    And(
      'the caller places a sticker on {string} day {int} for {string}',
      async (_c, habitName: string, day: number, memberName: string) => {
        const res = await placeSticker(habitName, memberName, day);
        expect(res.status).toBe(200);
      },
    );
    When(
      'the caller banks {int} stickers into savings for {string}',
      async (_c, count: number, memberName: string) => {
        const res = await app.request('/api/mw/financial/savings', {
          method: 'POST',
          headers: headers('khan'),
          body: JSON.stringify({
            memberId: memberIds[memberName]!,
            type: 'stickers',
            amount: count,
          }),
        });
        expect(res.status).toBe(201);
      },
    );
    And('the caller fetches savings for {string}', async (_c, memberName: string) => {
      await fetchSavings(memberName, 'khan');
    });
    Then('the savings show {int} stickers in total', (_c, total: number) => {
      expect(lastSavings.savedStickers).toBe(total);
    });
    And(
      'the split reads {int} earned last week and {int} kept from earlier',
      (_c, earned: number, kept: number) => {
        expect(lastSavings.earnedLastWeekStickers).toBe(earned);
        expect(lastSavings.keptFromEarlierStickers).toBe(kept);
        expect(lastSavings.earnedLastWeekStickers + lastSavings.keptFromEarlierStickers).toBe(
          lastSavings.savedStickers,
        );
      },
    );
  });

  Scenario(
    'an old balance with no recent banking reads entirely as kept',
    ({ When, And, Then }) => {
      When('the caller fetches savings for {string}', async (_c, memberName: string) => {
        await fetchSavings(memberName, 'khan');
      });
      Then('the savings show {int} stickers in total', (_c, total: number) => {
        expect(lastSavings.savedStickers).toBe(total);
      });
      And(
        'the split reads {int} earned last week and {int} kept from earlier',
        (_c, earned: number, kept: number) => {
          expect(lastSavings.earnedLastWeekStickers).toBe(earned);
          expect(lastSavings.keptFromEarlierStickers).toBe(kept);
        },
      );
    },
  );

  Scenario('tenant isolation', ({ Given, When, Then }) => {
    let crossTenantStatus = 0;
    Given(
      'a tenant {string} exists with the caller as an admin member',
      async (_c, slug: string) => {
        await seedTenant(slug);
      },
    );
    When(
      'the caller fetches savings for {string} through the {string} tenant',
      async (_c, memberName: string, slug: string) => {
        const res = await app.request(
          `/api/mw/financial/savings?memberId=${memberIds[memberName]!}`,
          { headers: headers(slug) },
        );
        crossTenantStatus = res.status;
      },
    );
    Then('the request is refused as not found', () => {
      // The guard 404s a member outside the caller's tenant, so another
      // family's split can never be read at all.
      expect(crossTenantStatus).toBe(404);
    });
  });
});
