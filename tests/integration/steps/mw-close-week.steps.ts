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
import { tenants, members, habits, mwWeeks, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(
  new URL('../features/mw-close-week.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'mw-close-week-kid';
const USER_ID = '00000000-0000-4000-8000-0000000007a7';
const USER_EMAIL = 'closeweek@example.com';

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
  let lastFinalize: { status: number; body: Record<string, unknown> };

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

  async function finalize(memberName: string, opts: { continueAll?: boolean } = {}) {
    const weekId = await currentWeekId(memberName);
    let continueInvestmentIds: string[] = [];
    if (opts.continueAll) {
      const res = await app.request(
        `/api/mw/financial/investments?memberId=${memberIds[memberName]!}`,
        { headers: headers('khan') },
      );
      const body = (await res.json()) as { investments: { id: string }[] };
      continueInvestmentIds = body.investments.map((i) => i.id);
    }
    const res = await app.request(`/api/mw/weeks/${weekId}/finalize`, {
      method: 'POST',
      headers: headers('khan'),
      body: JSON.stringify({ memberId: memberIds[memberName]!, continueInvestmentIds }),
    });
    lastFinalize = {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
    return lastFinalize;
  }

  async function savedStickers(memberName: string): Promise<number> {
    const res = await app.request(`/api/mw/financial/savings?memberId=${memberIds[memberName]!}`, {
      headers: headers('khan'),
    });
    const body = (await res.json()) as { savedStickers: number };
    return body.savedStickers;
  }

  async function activeInvestmentCount(memberName: string): Promise<number> {
    const res = await app.request(
      `/api/mw/financial/investments?memberId=${memberIds[memberName]!}`,
      { headers: headers('khan') },
    );
    const body = (await res.json()) as { investments: unknown[] };
    return body.investments.length;
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
    // FHS-512 — stickerValue now comes from `boost` (isBonus is legacy/derived
    // display-only). A direct DB insert bypasses the API's isBonus→boost
    // derivation, so set boost explicitly to keep "bonus" habits worth 5.
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
      'the {string} tenant has a bonus habit {string} for {string}',
      async (_c, slug: string, name: string, member: string) => {
        await seedHabit(slug, name, member, true);
      },
    );
  });

  Scenario(
    'Closing a week auto-saves unallocated stickers and opens the next week',
    ({ Given, When, Then, And }) => {
      Given(
        'the caller places a sticker on {string} day {int} for {string}',
        async (_c, h: string, day: number, m: string) => {
          await placeSticker(h, m, day);
        },
      );
      When('the caller closes the current week for {string}', async (_c, m: string) => {
        await finalize(m);
      });
      Then('the finalize response status is {int}', (_c, n: number) =>
        expect(lastFinalize.status).toBe(n),
      );
      And('the finalize response reports {int} stickers auto-saved', (_c, n: number) =>
        expect(lastFinalize.body.stickersAutoSaved).toBe(n),
      );
      And('the finalize response opens a next week', () =>
        expect(typeof lastFinalize.body.nextWeekId).toBe('string'),
      );
      And(
        '{string} has {int} saved stickers in tenant {string}',
        async (_c, m: string, n: number) => {
          expect(await savedStickers(m)).toBe(n);
        },
      );
    },
  );

  Scenario(
    'An investment resolves to savings on close when not continued',
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
        'the caller invests {int} stickers in {string} for {string}',
        async (_c, n: number, h: string, m: string) => {
          const res = await invest(h, m, n);
          expect(res.status).toBe(201);
        },
      );
      When('the caller closes the current week for {string}', async (_c, m: string) => {
        await finalize(m);
      });
      Then('the finalize response status is {int}', (_c, n: number) =>
        expect(lastFinalize.status).toBe(n),
      );
      And('the finalize response reports investment returns above {int}', (_c, n: number) =>
        expect(Number(lastFinalize.body.investmentReturns)).toBeGreaterThan(n),
      );
      And(
        '{string} has {int} active investments in tenant {string}',
        async (_c, m: string, n: number) => {
          expect(await activeInvestmentCount(m)).toBe(n);
        },
      );
    },
  );

  Scenario('A continued investment carries into the next week', ({ Given, And, When, Then }) => {
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
      'the caller invests {int} stickers in {string} for {string}',
      async (_c, n: number, h: string, m: string) => {
        const res = await invest(h, m, n);
        expect(res.status).toBe(201);
      },
    );
    When(
      'the caller closes the current week continuing the investment for {string}',
      async (_c, m: string) => {
        await finalize(m, { continueAll: true });
      },
    );
    Then('the finalize response status is {int}', (_c, n: number) =>
      expect(lastFinalize.status).toBe(n),
    );
    And('the finalize response reports {int} continued investment', (_c, n: number) =>
      expect(lastFinalize.body.continuedInvestments).toBe(n),
    );
    And(
      '{string} has {int} active investments in tenant {string}',
      async (_c, m: string, n: number) => {
        expect(await activeInvestmentCount(m)).toBe(n);
      },
    );
  });

  Scenario('A week cannot be finalized twice', ({ When, And, Then }) => {
    When('the caller closes the current week for {string}', async (_c, m: string) => {
      await finalize(m);
    });
    And('the caller closes the current week for {string}', async (_c, m: string) => {
      // Re-finalizing the same (now finalized) week: re-fetch current returns the
      // NEW open week, so target the finalized one directly via its number.
      const weekId = await finalizedWeekId(m);
      const res = await app.request(`/api/mw/weeks/${weekId}/finalize`, {
        method: 'POST',
        headers: headers('khan'),
        body: JSON.stringify({ memberId: memberIds[m]!, continueInvestmentIds: [] }),
      });
      lastFinalize = {
        status: res.status,
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
      };
    });
    Then('the finalize response status is {int}', (_c, n: number) =>
      expect(lastFinalize.status).toBe(n),
    );
  });

  Scenario(
    "An investment's value reflects every completed day, not just elapsed ones",
    ({ Given, And, When, Then }) => {
      let invValue: number;
      Given(
        'the caller completes all 7 days of {string} for {string}',
        async (_c, h: string, m: string) => {
          for (let day = 0; day < 7; day++) await placeSticker(h, m, day);
        },
      );
      And(
        'the caller invests {int} stickers in {string} for {string}',
        async (_c, n: number, h: string, m: string) => {
          const res = await invest(h, m, n);
          expect(res.status).toBe(201);
        },
      );
      When('the caller opens investments for {string}', async (_c, m: string) => {
        const res = await app.request(`/api/mw/financial/investments?memberId=${memberIds[m]!}`, {
          headers: headers('khan'),
        });
        const body = (await res.json()) as { investments: { currentValueStickers: number }[] };
        invValue = body.investments[0]?.currentValueStickers ?? -1;
      });
      Then('{string} first investment is worth {int} stickers', (_c, _m: string, n: number) => {
        // 10 invested + 7 completed*5 - 0 missed = 45, on ANY weekday (the value
        // must NOT be capped by elapsed days — that froze it, e.g. 10 on Monday).
        expect(invValue).toBe(n);
      });
    },
  );

  Scenario('No new week opens while an earlier week is still open', ({ Given, When, Then }) => {
    let currentWeek: { weekNumber: number; year: number };
    Given('{string} has an earlier open week from 2020', async (_c, m: string) => {
      await db.insert(mwWeeks).values({
        tenantId: tenantIds['khan']!,
        memberId: memberIds[m]!,
        weekNumber: 1,
        year: 2020,
        startDate: '2020-01-06',
        isFinalized: false,
      });
    });
    When('the caller checks the current week for {string}', async (_c, m: string) => {
      const res = await app.request(`/api/mw/weeks/current?memberId=${memberIds[m]!}`, {
        headers: headers('khan'),
      });
      const body = (await res.json()) as { week: { weekNumber: number; year: number } };
      currentWeek = body.week;
    });
    Then('the current week is the 2020 week', () => {
      // The calendar week is 2026, but an earlier (2020) week is still open, so
      // get-or-create must return THAT week rather than opening a new one.
      expect(currentWeek.year).toBe(2020);
      expect(currentWeek.weekNumber).toBe(1);
    });
  });

  Scenario('A caller cannot finalize across members', ({ Given, When, Then }) => {
    Given(
      'the {string} tenant has a child member {string}',
      async (_c, slug: string, name: string) => {
        await seedChild(slug, name);
      },
    );
    When(
      'the caller closes {string} current week using {string} as the member',
      async (_c, owner: string, other: string) => {
        const weekId = await currentWeekId(owner);
        const res = await app.request(`/api/mw/weeks/${weekId}/finalize`, {
          method: 'POST',
          headers: headers('khan'),
          body: JSON.stringify({ memberId: memberIds[other]!, continueInvestmentIds: [] }),
        });
        lastFinalize = {
          status: res.status,
          body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
        };
      },
    );
    Then('the finalize response status is {int}', (_c, n: number) =>
      expect(lastFinalize.status).toBe(n),
    );
  });

  // The first finalized week is the earliest one for this member.
  async function finalizedWeekId(memberName: string): Promise<string> {
    const res = await app.request(`/api/mw/weeks?memberId=${memberIds[memberName]!}`, {
      headers: headers('khan'),
    });
    const body = (await res.json()) as { weeks: { id: string; isFinalized: boolean }[] };
    const finalized = body.weeks.find((w) => w.isFinalized);
    return finalized?.id ?? body.weeks[0]!.id;
  }
});
