/**
 * Step bindings for mw-investment-coefficient.feature (FHS-534).
 *
 * Real Postgres on :5433, proves the per-investment coefficient behaviour:
 * a chosen preset (1/2/3/5) is persisted on the mw_investments row AND
 * pushed onto the invested habit's `boost` (the invest→pay link), omitting
 * it falls back to the legacy default of 5, daily growth uses the
 * coefficient (not a hardcoded +5/day), and cross-tenant investing is
 * rejected. Mirrors the auth + seed scaffold of mw-investment-deductible.steps.ts.
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
  habitStickers,
  mwSavings,
  users,
} from '../../../apps/api/src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(
  new URL('../features/mw-investment-coefficient.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'mw-investment-coefficient-kid';
const USER_ID = '00000000-0000-4000-8000-0000000007e9';
const USER_EMAIL = 'coefficient@example.com';

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
  let lastInvest: { status: number; body: Record<string, unknown> };
  let investmentValueStickers: number;

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

  async function invest(
    habitName: string,
    memberName: string,
    count: number,
    opts: { coefficient?: number; tenantSlug?: string } = {},
  ) {
    const tenantSlug = opts.tenantSlug ?? 'khan';
    const body: Record<string, unknown> = {
      memberId: memberIds[memberName]!,
      habitId: habitIds[habitName]!,
      stickerCount: count,
    };
    if (opts.coefficient !== undefined) body['coefficient'] = opts.coefficient;
    return app.request(`/api/mw/financial/investments`, {
      method: 'POST',
      headers: headers(tenantSlug),
      body: JSON.stringify(body),
    });
  }

  async function loadInvestments(
    memberName: string,
    tenantSlug = 'khan',
  ): Promise<Array<{ id: string; currentValueStickers: number; coefficient: number }>> {
    const res = await app.request(
      `/api/mw/financial/investments?memberId=${memberIds[memberName]!}`,
      { headers: headers(tenantSlug) },
    );
    const body = (await res.json()) as {
      investments: Array<{ id: string; currentValueStickers: number; coefficient: number }>;
    };
    return body.investments;
  }

  async function habitBoost(habitName: string): Promise<number | undefined> {
    const rows = await db
      .select({ boost: habits.boost })
      .from(habits)
      .where(eq(habits.id, habitIds[habitName]!))
      .limit(1);
    return rows[0]?.boost;
  }

  // FHS-517: the stored sticker_value for one (habit, member, day). Placing a
  // sticker sets stickerValue = the habit's current boost, so re-tapping the
  // same day after the boost changed upserts the new value.
  async function dayStickerValue(
    habitName: string,
    memberName: string,
    day: number,
  ): Promise<number | undefined> {
    const rows = await db
      .select({ value: habitStickers.stickerValue })
      .from(habitStickers)
      .where(
        and(
          eq(habitStickers.habitId, habitIds[habitName]!),
          eq(habitStickers.memberId, memberIds[memberName]!),
          eq(habitStickers.day, day),
        ),
      )
      .limit(1);
    return rows[0]?.value;
  }

  async function withdraw(memberName: string, stickers?: number) {
    const [inv] = await loadInvestments(memberName);
    const body: Record<string, unknown> = { memberId: memberIds[memberName]! };
    if (stickers !== undefined) body['stickers'] = stickers;
    const res = await app.request(`/api/mw/financial/investments/${inv!.id}/withdraw`, {
      method: 'POST',
      headers: headers('khan'),
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
  }

  async function finalizeWeek(memberName: string) {
    const weekId = await currentWeekId(memberName);
    const res = await app.request(`/api/mw/weeks/${weekId}/finalize`, {
      method: 'POST',
      headers: headers('khan'),
      body: JSON.stringify({ memberId: memberIds[memberName]!, continueInvestmentIds: [] }),
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
  }

  async function setHabitBoost(habitName: string, memberName: string, boost: number) {
    return app.request(`/api/habits/${habitIds[habitName]!}`, {
      method: 'PUT',
      headers: headers('khan'),
      body: JSON.stringify({ memberId: memberIds[memberName]!, boost }),
    });
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
    // Seed saved stickers so the child can fund a 10-sticker investment
    // without placing 10 habit stickers first: the placed-sticker
    // scenarios below need day counts to stay exactly at the number the
    // maturation assertions expect, while the create endpoint draws the
    // principal savings-first.
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
      async (_c, slug: string, name: string, member: string) => {
        await seedHabit(slug, name, member);
      },
    );
  });

  Scenario(
    "Investing with a chosen coefficient sets it on the investment and the habit's boost",
    ({ When, Then, And }) => {
      When(
        'the caller invests {int} stickers in {string} for {string} with coefficient {int}',
        async (_c, n: number, h: string, m: string, coeff: number) => {
          const res = await invest(h, m, n, { coefficient: coeff });
          lastInvest = {
            status: res.status,
            body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
          };
        },
      );
      Then('the investment response status is {int}', (_c, n: number) =>
        expect(lastInvest.status).toBe(n),
      );
      And('the investment response coefficient is {int}', (_c, n: number) =>
        expect(lastInvest.body['coefficient']).toBe(n),
      );
      And('{string} habit boost is {int}', async (_c, h: string, n: number) => {
        expect(await habitBoost(h)).toBe(n);
      });
    },
  );

  Scenario(
    "Investing without a coefficient defaults to 5 on the investment and the habit's boost",
    ({ When, Then, And }) => {
      When(
        'the caller invests {int} stickers in {string} for {string}',
        async (_c, n: number, h: string, m: string) => {
          const res = await invest(h, m, n);
          lastInvest = {
            status: res.status,
            body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
          };
        },
      );
      Then('the investment response status is {int}', (_c, n: number) =>
        expect(lastInvest.status).toBe(n),
      );
      And('the investment response coefficient is {int}', (_c, n: number) =>
        expect(lastInvest.body['coefficient']).toBe(n),
      );
      And('{string} habit boost is {int}', async (_c, h: string, n: number) => {
        expect(await habitBoost(h)).toBe(n);
      });
    },
  );

  Scenario(
    "Daily growth uses the investment's coefficient, not a hardcoded rate",
    ({ Given, And, When, Then }) => {
      Given(
        'the caller completes all 7 days of {string} for {string}',
        async (_c, h: string, m: string) => {
          for (let day = 0; day < 7; day++) await placeSticker(h, m, day);
        },
      );
      And(
        'the caller invests {int} stickers in {string} for {string} with coefficient {int}',
        async (_c, n: number, h: string, m: string, coeff: number) => {
          const res = await invest(h, m, n, { coefficient: coeff });
          expect(res.status).toBe(201);
        },
      );
      When('the caller opens investments for {string}', async (_c, m: string) => {
        const [first] = await loadInvestments(m);
        investmentValueStickers = first?.currentValueStickers ?? -1;
      });
      Then('{string} first investment is worth {int} stickers', (_c, _m: string, n: number) => {
        // 10 invested + 7 completed*2 (coefficient) - 0 missed = 24, NOT the
        // legacy hardcoded +5/day (which would give 45).
        expect(investmentValueStickers).toBe(n);
      });
    },
  );

  Scenario("A caller cannot invest in another tenant's habit", ({ Given, And, When, Then }) => {
    Given(
      'a tenant {string} exists with the caller as an admin member',
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
    When(
      'the caller invests {int} stickers in {string} for {string} in tenant {string}',
      async (_c, n: number, h: string, m: string, tenantSlug: string) => {
        const res = await invest(h, m, n, { tenantSlug });
        lastInvest = {
          status: res.status,
          body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
        };
      },
    );
    Then('the investment response status is {int}', (_c, n: number) =>
      expect(lastInvest.status).toBe(n),
    );
  });

  Scenario(
    'Withdrawing an active investment uses its own coefficient, not a hardcoded rate',
    ({ Given, And, When, Then }) => {
      let lastWithdraw: { status: number; body: Record<string, unknown> };
      Given(
        'the caller completes all 7 days of {string} for {string}',
        async (_c, h: string, m: string) => {
          for (let day = 0; day < 7; day++) await placeSticker(h, m, day);
        },
      );
      And(
        'the caller invests {int} stickers in {string} for {string} with coefficient {int}',
        async (_c, n: number, h: string, m: string, coeff: number) => {
          const res = await invest(h, m, n, { coefficient: coeff });
          expect(res.status).toBe(201);
        },
      );
      When(
        'the caller withdraws {int} stickers from the investment for {string}',
        async (_c, n: number, m: string) => {
          lastWithdraw = await withdraw(m, n);
        },
      );
      Then('the withdraw response withdrawn stickers is {int}', (_c, n: number) =>
        // 10 invested + 7 completed*2 (coefficient) - 0 missed = 24 available;
        // withdrawing 10 must succeed and report exactly 10: a hardcoded
        // +5/day rate would still allow this (24 or 45 both cover 10), so the
        // remaining-balance assertion below is what actually pins the rate.
        expect(lastWithdraw.body['withdrawnStickers']).toBe(n),
      );
      And('the withdraw response remaining stickers is {int}', (_c, n: number) =>
        // 24 total - 10 withdrawn = 14. A hardcoded +5/day rate would leave
        // 45 - 10 = 35 instead: this is the assertion that actually proves
        // the withdraw recompute used the investment's own coefficient.
        expect(lastWithdraw.body['remainingStickers']).toBe(n),
      );
    },
  );

  Scenario(
    'Closing the week matures an active investment at its own coefficient, not a hardcoded rate',
    ({ Given, And, When, Then }) => {
      let lastFinalize: { status: number; body: Record<string, unknown> };
      Given(
        'the caller completes all 7 days of {string} for {string}',
        async (_c, h: string, m: string) => {
          for (let day = 0; day < 7; day++) await placeSticker(h, m, day);
        },
      );
      And(
        'the caller invests {int} stickers in {string} for {string} with coefficient {int}',
        async (_c, n: number, h: string, m: string, coeff: number) => {
          const res = await invest(h, m, n, { coefficient: coeff });
          expect(res.status).toBe(201);
        },
      );
      When('the caller closes the current week for {string}', async (_c, m: string) => {
        lastFinalize = await finalizeWeek(m);
      });
      Then('the finalize response investment returns is {number}', (_c, n: number) =>
        // 10 invested + 7 completed*3 (coefficient) - 0 missed = 31 stickers,
        // matured to cash at the default 0.5 rate = 15.5. A hardcoded +5/day
        // rate would mature to 45 stickers (22.5 cash) instead.
        expect(Number(lastFinalize.body['investmentReturns'])).toBeCloseTo(n, 5),
      );
    },
  );

  Scenario(
    "Editing the habit's pay later does not disturb an active investment's growth",
    ({ Given, And, When, Then }) => {
      Given(
        'the caller invests {int} stickers in {string} for {string} with coefficient {int}',
        async (_c, n: number, h: string, m: string, coeff: number) => {
          const res = await invest(h, m, n, { coefficient: coeff });
          expect(res.status).toBe(201);
        },
      );
      And(
        'the caller completes all 7 days of {string} for {string}',
        async (_c, h: string, m: string) => {
          for (let day = 0; day < 7; day++) await placeSticker(h, m, day);
        },
      );
      When(
        'the caller sets {string} habit boost to {int} for {string}',
        async (_c, h: string, n: number, m: string) => {
          const res = await setHabitBoost(h, m, n);
          expect(res.status).toBe(200);
        },
      );
      And('the caller opens investments for {string}', async (_c, m: string) => {
        const [first] = await loadInvestments(m);
        investmentValueStickers = first?.currentValueStickers ?? -1;
      });
      Then('{string} first investment is worth {int} stickers', (_c, _m: string, n: number) => {
        // 10 invested + 7 completed*5 (the investment's OWN snapshotted
        // coefficient) - 0 missed = 45: unaffected by the habit-boost edit
        // below. A leaked boost of 2 would give 10 + 7*2 = 24 instead.
        expect(investmentValueStickers).toBe(n);
      });
      And('{string} habit boost is {int}', async (_c, h: string, n: number) => {
        // Confirms the edit actually landed (so the assertion above is
        // proving snapshot separation, not that the PUT silently no-op'd).
        expect(await habitBoost(h)).toBe(n);
      });
    },
  );

  Scenario(
    "Re-tapping a day's sticker after the boost changed picks up the new boost",
    ({ Given, And, When, Then }) => {
      const placeOnDay = async (_c: unknown, day: number, h: string, m: string) => {
        const res = await placeSticker(h, m, day);
        expect(res.status).toBe(200);
      };
      const assertDayValue = async (_c: unknown, day: number, h: string, m: string, v: number) => {
        expect(await dayStickerValue(h, m, day)).toBe(v);
      };
      Given('the caller places a sticker on day {int} of {string} for {string}', placeOnDay);
      And('the day {int} sticker value for {string} for {string} is {int}', assertDayValue);
      When(
        'the caller sets {string} habit boost to {int} for {string}',
        async (_c, h: string, n: number, m: string) => {
          const res = await setHabitBoost(h, m, n);
          expect(res.status).toBe(200);
        },
      );
      And('the caller places a sticker on day {int} of {string} for {string}', placeOnDay);
      Then('the day {int} sticker value for {string} for {string} is {int}', assertDayValue);
    },
  );
});
