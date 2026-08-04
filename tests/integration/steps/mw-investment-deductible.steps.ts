/**
 * Step bindings for mw-investment-deductible.feature (FHS-378).
 *
 * Real Postgres on :5433, proves the deductible vs non-deductible investment
 * behaviour: a non-deductible investment counts missed days but never loses
 * value for them, a deductible one drops by −2/missed day, GET returns the
 * flag, the flag survives a close-week continuation, and the settings endpoint
 * toggles it. Mirrors the auth + seed scaffold of mw-close-week.steps.ts.
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
import {
  tenants,
  members,
  habits,
  mwInvestments,
  mwSavings,
  users,
} from '../../../apps/api/src/db/schema.js';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(
  new URL('../features/mw-investment-deductible.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'mw-investment-deductible-kid';
const USER_ID = '00000000-0000-4000-8000-0000000007d8';
const USER_EMAIL = 'deductible@example.com';

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

interface InvestmentItem {
  id: string;
  currentValueStickers: number;
  deductible: boolean;
}

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let token: string;
  const tenantIds: Record<string, string> = {};
  const memberIds: Record<string, string> = {};
  const habitIds: Record<string, string> = {};
  let investments: InvestmentItem[] = [];
  let lastSettings: { status: number; body: Record<string, unknown> };

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

  async function invest(habitName: string, memberName: string, count: number, deductible: boolean) {
    return app.request(`/api/mw/financial/investments`, {
      method: 'POST',
      headers: headers('khan'),
      body: JSON.stringify({
        memberId: memberIds[memberName]!,
        habitId: habitIds[habitName]!,
        stickerCount: count,
        deductible,
      }),
    });
  }

  async function loadInvestments(memberName: string): Promise<InvestmentItem[]> {
    const res = await app.request(
      `/api/mw/financial/investments?memberId=${memberIds[memberName]!}`,
      { headers: headers('khan') },
    );
    const body = (await res.json()) as { investments: InvestmentItem[] };
    return body.investments;
  }

  async function finalizeContinuing(memberName: string) {
    const weekId = await currentWeekId(memberName);
    const continueInvestmentIds = (await loadInvestments(memberName)).map((i) => i.id);
    await app.request(`/api/mw/weeks/${weekId}/finalize`, {
      method: 'POST',
      headers: headers('khan'),
      body: JSON.stringify({ memberId: memberIds[memberName]!, continueInvestmentIds }),
    });
  }

  // Read the active investment row straight from Postgres. After a continuation
  // the matured value becomes the new working principal (invested_stickers), so
  // this is the deterministic surface to assert the maturation maths on,
  // unlike a fresh GET, which re-derives value against the NEW (real-clock) week.
  async function activeInvestmentRow(
    memberName: string,
  ): Promise<{ investedStickers: number; deductible: boolean } | undefined> {
    const rows = await db
      .select({
        investedStickers: mwInvestments.investedStickers,
        deductible: mwInvestments.deductible,
      })
      .from(mwInvestments)
      .where(
        and(
          eq(mwInvestments.tenantId, tenantIds['khan']!),
          eq(mwInvestments.memberId, memberIds[memberName]!),
          eq(mwInvestments.isActive, true),
        ),
      )
      .limit(1);
    return rows[0];
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
    // Seed saved stickers so the child can fund a 10-sticker investment without
    // placing 10 habit stickers this week: the placed stickers must stay at the
    // exact count the maturation assertions expect (completed days), while the
    // create endpoint draws the principal savings-first.
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
      investments = [];
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
      async (_c, slug: string, name: string, member: string) => {
        await seedHabit(slug, name, member);
      },
    );
  });

  Scenario(
    'GET returns the deductible flag for a non-deductible investment',
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
      And(
        'the caller invests {int} non-deductible stickers in {string} for {string}',
        async (_c, n: number, h: string, m: string) => {
          const res = await invest(h, m, n, false);
          expect(res.status).toBe(201);
        },
      );
      When('the caller opens investments for {string}', async (_c, m: string) => {
        investments = await loadInvestments(m);
      });
      Then('{string} first investment deductible flag is false', () => {
        expect(investments[0]?.deductible).toBe(false);
      });
    },
  );

  Scenario(
    'A non-deductible investment loses no value to missed days on close',
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
      And(
        'the caller invests {int} non-deductible stickers in {string} for {string}',
        async (_c, n: number, h: string, m: string) => {
          const res = await invest(h, m, n, false);
          expect(res.status).toBe(201);
        },
      );
      When(
        'the caller closes the current week continuing the investment for {string}',
        async (_c, m: string) => {
          await finalizeContinuing(m);
        },
      );
      Then(
        '{string} continued investment principal is {int} stickers',
        async (_c, m: string, n: number) => {
          // 10 invested + 2 completed*5 - 0 penalty (non-deductible) = 20.
          const row = await activeInvestmentRow(m);
          expect(row?.investedStickers).toBe(n);
        },
      );
    },
  );

  Scenario(
    'A deductible investment drops by the penalty for missed days on close',
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
      And(
        'the caller invests {int} deductible stickers in {string} for {string}',
        async (_c, n: number, h: string, m: string) => {
          const res = await invest(h, m, n, true);
          expect(res.status).toBe(201);
        },
      );
      When(
        'the caller closes the current week continuing the investment for {string}',
        async (_c, m: string) => {
          await finalizeContinuing(m);
        },
      );
      Then(
        '{string} continued investment principal is {int} stickers',
        async (_c, m: string, n: number) => {
          // 10 invested + 2 completed*5 - 5 missed*2 = 10.
          const row = await activeInvestmentRow(m);
          expect(row?.investedStickers).toBe(n);
        },
      );
    },
  );

  Scenario(
    'The deductible flag is preserved across a close-week continuation',
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
      And(
        'the caller invests {int} non-deductible stickers in {string} for {string}',
        async (_c, n: number, h: string, m: string) => {
          const res = await invest(h, m, n, false);
          expect(res.status).toBe(201);
        },
      );
      When(
        'the caller closes the current week continuing the investment for {string}',
        async (_c, m: string) => {
          await finalizeContinuing(m);
        },
      );
      Then('{string} continued investment is still non-deductible', async (_c, m: string) => {
        // The continued row keeps deductible=false through the roll-over.
        const row = await activeInvestmentRow(m);
        expect(row?.deductible).toBe(false);
      });
    },
  );

  Scenario(
    'The settings endpoint toggles the flag and recalculates value',
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
      And(
        'the caller invests {int} deductible stickers in {string} for {string}',
        async (_c, n: number, h: string, m: string) => {
          const res = await invest(h, m, n, true);
          expect(res.status).toBe(201);
        },
      );
      When(
        'the caller sets the investment for {string} to non-deductible',
        async (_c, m: string) => {
          const id = (await loadInvestments(m))[0]!.id;
          const res = await app.request(`/api/mw/financial/investments/${id}/settings`, {
            method: 'POST',
            headers: headers('khan'),
            body: JSON.stringify({ memberId: memberIds[m]!, deductible: false }),
          });
          lastSettings = {
            status: res.status,
            body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
          };
        },
      );
      Then('the settings response status is {int}', (_c, n: number) =>
        expect(lastSettings.status).toBe(n),
      );
      And('the settings response deductible flag is false', () =>
        expect(lastSettings.body.deductible).toBe(false),
      );
    },
  );
});
