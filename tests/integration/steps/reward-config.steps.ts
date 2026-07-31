/**
 * Step bindings for reward-config.feature (FHS-512).
 *
 * Real Postgres + real Hono routers (habits, mw-weeks, mw-financial,
 * reward-config). Covers: configurable sticker rate (family default + per-
 * child override), habit boost, and the skip-penalty accrual/reversal at
 * close-week. Every money assertion is in INTEGER MINOR UNITS.
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
import { rewardConfigRouter } from '../../../apps/api/src/routes/reward-config.js';
import { tenants, members, habits, mwSavings, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(
  new URL('../features/reward-config.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'reward-config-kid';
const USER_ID = '00000000-0000-4000-8000-0000000008b8';
const USER_EMAIL = 'rewardconfig@example.com';
const USER2_ID = '00000000-0000-4000-8000-0000000008b9';
const USER2_EMAIL = 'rewardconfig2@example.com';

async function genKey() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = 'ES256';
  publicJwk.kid = KID;
  publicJwk.use = 'sig';
  return { privateKey, publicJwk };
}

async function mintToken(privateKey: KeyLike, subject: string, email: string) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setSubject(subject)
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
  let token2: string;
  const tenantIds: Record<string, string> = {};
  const memberIds: Record<string, string> = {};
  const habitIds: Record<string, string> = {};
  let lastRes: { status: number; body: Record<string, unknown> };
  let lastFinalize: { status: number; body: Record<string, unknown> };
  let savedCashBefore: number;

  function headers(slug: string, useToken = token) {
    return {
      Authorization: `Bearer ${useToken}`,
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

  async function finalize(memberName: string) {
    const weekId = await currentWeekId(memberName);
    const res = await app.request(`/api/mw/weeks/${weekId}/finalize`, {
      method: 'POST',
      headers: headers('khan'),
      body: JSON.stringify({ memberId: memberIds[memberName]!, continueInvestmentIds: [] }),
    });
    lastFinalize = {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
    return lastFinalize;
  }

  async function reopen(memberName: string) {
    const res = await app.request(`/api/mw/weeks/${lastFinalizedWeekId}/reopen`, {
      method: 'POST',
      headers: headers('khan'),
      body: JSON.stringify({ memberId: memberIds[memberName]! }),
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
  }
  let lastFinalizedWeekId: string;

  async function savingsFor(memberName: string): Promise<{
    savedStickers: number;
    savedCash: number;
    stickerRate: number;
    stickerRateMinor: number;
  }> {
    const res = await app.request(`/api/mw/financial/savings?memberId=${memberIds[memberName]!}`, {
      headers: headers('khan'),
    });
    return (await res.json()) as never;
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

  async function seedAdult(slug: string, name: string) {
    const [row] = await db
      .insert(members)
      .values({ tenantId: tenantIds[slug]!, userId: null, displayName: name, role: 'adult' })
      .returning();
    memberIds[name] = row!.id;
  }

  // FIX 5 — applySkipPenalties now only penalises days on/after a habit's
  // createdAt. Every OTHER scenario in this file seeds a habit and closes
  // the CURRENT (real) week expecting all 7 days to be due, regardless of
  // which real-world weekday the test happens to run on — so seedHabit
  // backdates createdAt well before any week's Monday by default. The
  // FIX 5 scenario passes its own createdAt to exercise the exclusion.
  const HABIT_SAFELY_BEFORE_ANY_WEEK = new Date('2020-01-01T00:00:00.000Z');

  async function seedHabit(
    slug: string,
    name: string,
    memberName: string,
    opts: { boost?: number; skipPenaltyMinor?: number; createdAt?: Date } = {},
  ) {
    const [row] = await db
      .insert(habits)
      .values({
        tenantId: tenantIds[slug]!,
        memberId: memberIds[memberName]!,
        name,
        boost: opts.boost ?? 1,
        skipPenaltyMinor: opts.skipPenaltyMinor ?? 0,
        createdAt: opts.createdAt ?? HABIT_SAFELY_BEFORE_ANY_WEEK,
      })
      .returning();
    habitIds[name] = row!.id;
  }

  async function seedTenant(slug: string, userId: string) {
    const [tenant] = await db
      .insert(tenants)
      .values({ slug, name: `${slug} Family` })
      .returning();
    tenantIds[slug] = tenant!.id;
    await db
      .insert(members)
      .values({ tenantId: tenant!.id, userId, displayName: 'Caller', role: 'admin' });
  }

  Background(({ Given, And }) => {
    Given('the test Postgres has clean reward-config tables', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE money_adjustments RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE mw_savings_transactions RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE mw_week_actions RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE mw_savings RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE habit_stickers RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE mw_weeks RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE habits RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${USER_ID}, ${USER2_ID})`);
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
      await db.execute(
        sql`INSERT INTO users (id, email) VALUES (${USER2_ID}, ${USER2_EMAIL})
            ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      );
      const { privateKey, publicJwk } = await genKey();
      app = new Hono();
      app.use(
        '*',
        authMiddleware({
          issuer: ISSUER,
          jwks: makeJwks(publicJwk),
          userMirrorSync: async (claims: { id: string }) => {
            const rows = await db
              .select()
              .from(users)
              .where(sql`id = ${claims.id}`)
              .limit(1);
            return rows[0]!;
          },
        }),
      );
      app.use('*', resolveTenantFromHeader);
      app.route('/api/habits', habitsRouter);
      app.route('/api/mw/weeks', mwWeeksRouter);
      app.route('/api/mw/financial', mwFinancialRouter);
      app.route('/api/reward-config', rewardConfigRouter);
      token = await mintToken(privateKey, USER_ID, USER_EMAIL);
      token2 = await mintToken(privateKey, USER2_ID, USER2_EMAIL);
    });

    And('a tenant {string} exists with the caller as an admin member', async (_c, slug: string) => {
      await seedTenant(slug, USER_ID);
    });

    And(
      'the {string} tenant has a child member {string}',
      async (_c, slug: string, name: string) => {
        await seedChild(slug, name);
      },
    );
  });

  // ── GET default rate ────────────────────────────────────────────────────

  Scenario(
    'GET reward-config returns the default family rate for a family that never configured one',
    ({ When, Then, And }) => {
      When('the caller GETs the reward config', async () => {
        const res = await app.request('/api/reward-config', { headers: headers('khan') });
        lastRes = { status: res.status, body: (await res.json()) as Record<string, unknown> };
      });
      Then('the reward-config response status is {int}', (_c, n: number) =>
        expect(lastRes.status).toBe(n),
      );
      And('the family rate is {int} minor units', (_c, n: number) =>
        expect(lastRes.body['familyRateMinor']).toBe(n),
      );
    },
  );

  // ── PUT admin gate ───────────────────────────────────────────────────────

  Scenario('PUT reward-config as a non-admin is forbidden', ({ Given, When, Then }) => {
    Given('the {string} tenant has a non-admin member {string}', async (_c, slug, name) => {
      await seedAdult(slug as string, name as string);
    });
    When('{string} PUTs the reward config with familyRateMinor {int}', async (_c, name, n) => {
      // Non-admin caller needs their OWN token; mint one bound to their member's
      // user row is out of scope here, so instead flip THIS member's userId to
      // USER2 and authenticate as USER2 against the same tenant.
      await db
        .update(members)
        .set({ userId: USER2_ID })
        .where(sql`id = ${memberIds[name as string]!}`);
      const res = await app.request('/api/reward-config', {
        method: 'PUT',
        headers: headers('khan', token2),
        body: JSON.stringify({ familyRateMinor: n }),
      });
      lastRes = { status: res.status, body: (await res.json()) as Record<string, unknown> };
    });
    Then('the reward-config response status is {int}', (_c, n: number) =>
      expect(lastRes.status).toBe(n),
    );
  });

  // ── Family rate change reflected in a child's savings ───────────────────

  Scenario(
    "An admin sets the family default rate and it is reflected in a child's savings",
    ({ Given, When, Then, And }) => {
      Given('{string} has {int} saved stickers and no saved cash', async (_c, name, n) => {
        await db.insert(mwSavings).values({
          tenantId: tenantIds['khan']!,
          memberId: memberIds[name as string]!,
          savedStickers: n as number,
          savedCash: '0',
        });
      });
      When(
        'the caller PUTs the reward config with familyRateMinor {int}',
        async (_c, n: number) => {
          const res = await app.request('/api/reward-config', {
            method: 'PUT',
            headers: headers('khan'),
            body: JSON.stringify({ familyRateMinor: n }),
          });
          lastRes = { status: res.status, body: (await res.json()) as Record<string, unknown> };
        },
      );
      Then('the reward-config response status is {int}', (_c, n: number) =>
        expect(lastRes.status).toBe(n),
      );
      And('{string} savings stickerRate is {number}', async (_c, name, rate: number) => {
        const savings = await savingsFor(name as string);
        expect(savings.stickerRate).toBeCloseTo(rate);
      });
    },
  );

  // ── Per-child override precedence ────────────────────────────────────────

  Scenario(
    'An admin sets a per-child override that takes precedence over the family default',
    ({ When, Then, And }) => {
      When(
        'the caller PUTs a rate override of {int} minor units for {string}',
        async (_c, n, name) => {
          const res = await app.request('/api/reward-config', {
            method: 'PUT',
            headers: headers('khan'),
            body: JSON.stringify({
              memberOverrides: [{ memberId: memberIds[name as string]!, rateMinor: n }],
            }),
          });
          lastRes = { status: res.status, body: (await res.json()) as Record<string, unknown> };
        },
      );
      Then('{string} effective rate is {int} minor units', (_c, name, n: number) => {
        const body = lastRes.body as {
          members: Array<{ memberId: string; effectiveRateMinor: number }>;
        };
        const row = body.members.find((m) => m.memberId === memberIds[name as string]);
        expect(row?.effectiveRateMinor).toBe(n);
      });
      And('the family default rate is still {int} minor units', (_c, n: number) =>
        expect(lastRes.body['familyRateMinor']).toBe(n),
      );
    },
  );

  // ── Clearing an override ────────────────────────────────────────────────

  Scenario(
    "Clearing a child's rate override falls back to the family default",
    ({ Given, When, Then }) => {
      Given('{string} has a rate override of {int} minor units', async (_c, name, n) => {
        await db
          .update(members)
          .set({ stickerRateMinor: n as number })
          .where(sql`id = ${memberIds[name as string]!}`);
      });
      When('the caller clears {string} rate override', async (_c, name) => {
        const res = await app.request('/api/reward-config', {
          method: 'PUT',
          headers: headers('khan'),
          body: JSON.stringify({
            memberOverrides: [{ memberId: memberIds[name as string]!, rateMinor: null }],
          }),
        });
        lastRes = { status: res.status, body: (await res.json()) as Record<string, unknown> };
      });
      Then('{string} effective rate is {int} minor units', (_c, name, n: number) => {
        const body = lastRes.body as {
          members: Array<{ memberId: string; effectiveRateMinor: number }>;
        };
        const row = body.members.find((m) => m.memberId === memberIds[name as string]);
        expect(row?.effectiveRateMinor).toBe(n);
      });
    },
  );

  // ── Boost ────────────────────────────────────────────────────────────────

  Scenario('A boosted habit awards more stickers per completion', ({ Given, When, Then }) => {
    Given(
      'the {string} tenant has a habit {string} for {string} with boost {int}',
      async (_c, slug, name, member, boost: number) => {
        await seedHabit(slug as string, name as string, member as string, { boost });
      },
    );
    When(
      'the caller places a sticker on {string} day {int} for {string}',
      async (_c, h: string, day: number, m: string) => {
        await placeSticker(h, m, day);
      },
    );
    Then('the placed sticker is worth {int}', async (_c, n: number) => {
      const res = await app.request(`/api/habits?memberId=${memberIds['Ali']!}`, {
        headers: headers('khan'),
      });
      const body = (await res.json()) as { stickers: Array<{ stickerValue: number }> };
      expect(body.stickers[0]?.stickerValue).toBe(n);
    });
  });

  // ── Skip penalty accrual ────────────────────────────────────────────────

  Scenario(
    'A skip penalty deducts money from savings at close-week',
    ({ Given, When, Then, And }) => {
      Given(
        'the {string} tenant has a habit {string} for {string} with a skip penalty of {int} minor units',
        async (_c, slug, name, member, penalty: number) => {
          await seedHabit(slug as string, name as string, member as string, {
            skipPenaltyMinor: penalty,
          });
        },
      );
      And(
        '{string} has {number} saved cash and no saved stickers',
        async (_c, name, cash: number) => {
          await db.insert(mwSavings).values({
            tenantId: tenantIds['khan']!,
            memberId: memberIds[name as string]!,
            savedStickers: 0,
            savedCash: String(cash),
          });
        },
      );
      When('the caller closes the current week for {string}', async (_c, m: string) => {
        savedCashBefore = (await savingsFor(m)).savedCash;
        await finalize(m);
      });
      Then('the finalize response reports a skip penalty of {int} minor units', (_c, n: number) =>
        expect(lastFinalize.body['skipPenaltyMinor']).toBe(n),
      );
      And(
        '{string} saved cash is {number} lower than before close',
        async (_c, m, delta: number) => {
          const after = (await savingsFor(m as string)).savedCash;
          expect(savedCashBefore - after).toBeCloseTo(delta);
        },
      );
    },
  );

  // ── Skip penalty floors at zero ─────────────────────────────────────────

  Scenario('A skip penalty never lets saved cash go below zero', ({ Given, And, When, Then }) => {
    Given(
      'the {string} tenant has a habit {string} for {string} with a skip penalty of {int} minor units',
      async (_c, slug, name, member, penalty: number) => {
        await seedHabit(slug as string, name as string, member as string, {
          skipPenaltyMinor: penalty,
        });
      },
    );
    And(
      '{string} has {number} saved cash and no saved stickers',
      async (_c, name, cash: number) => {
        await db.insert(mwSavings).values({
          tenantId: tenantIds['khan']!,
          memberId: memberIds[name as string]!,
          savedStickers: 0,
          savedCash: String(cash),
        });
      },
    );
    When('the caller closes the current week for {string}', async (_c, m: string) => {
      await finalize(m);
    });
    Then('{string} saved cash is {int}', async (_c, m, n: number) => {
      const savings = await savingsFor(m as string);
      expect(savings.savedCash).toBe(n);
    });
  });

  // ── Only missing days penalised ──────────────────────────────────────────

  Scenario(
    'Only DUE days that are actually missing a sticker are penalised',
    ({ Given, And, When, Then }) => {
      Given(
        'the {string} tenant has a habit {string} for {string} with a skip penalty of {int} minor units',
        async (_c, slug, name, member, penalty: number) => {
          await seedHabit(slug as string, name as string, member as string, {
            skipPenaltyMinor: penalty,
          });
        },
      );
      And(
        'the caller places stickers on {string} days 0 and 1 for {string}',
        async (_c, h: string, m: string) => {
          await placeSticker(h, m, 0);
          await placeSticker(h, m, 1);
        },
      );
      When('the caller closes the current week for {string}', async (_c, m: string) => {
        await finalize(m);
      });
      Then('the finalize response reports a skip penalty of {int} minor units', (_c, n: number) =>
        expect(lastFinalize.body['skipPenaltyMinor']).toBe(n),
      );
    },
  );

  // ── Reopen reverses the penalty ─────────────────────────────────────────

  Scenario('Reopening a week restores the skip-penalty deduction', ({ Given, When, And, Then }) => {
    Given(
      'the {string} tenant has a habit {string} for {string} with a skip penalty of {int} minor units',
      async (_c, slug, name, member, penalty: number) => {
        await seedHabit(slug as string, name as string, member as string, {
          skipPenaltyMinor: penalty,
        });
      },
    );
    And(
      '{string} has {number} saved cash and no saved stickers',
      async (_c, name, cash: number) => {
        await db.insert(mwSavings).values({
          tenantId: tenantIds['khan']!,
          memberId: memberIds[name as string]!,
          savedStickers: 0,
          savedCash: String(cash),
        });
      },
    );
    When('the caller closes the current week for {string}', async (_c, m: string) => {
      savedCashBefore = (await savingsFor(m)).savedCash;
      const result = await finalize(m);
      expect(result.status).toBe(200);
    });
    And('the caller reopens that week for {string}', async (_c, m: string) => {
      const res = await app.request(`/api/mw/weeks?memberId=${memberIds[m as string]!}`, {
        headers: headers('khan'),
      });
      const body = (await res.json()) as { weeks: { id: string; isFinalized: boolean }[] };
      lastFinalizedWeekId = body.weeks.find((w) => w.isFinalized)?.id ?? body.weeks[0]!.id;
      const result = await reopen(m as string);
      expect(result.status).toBe(200);
    });
    Then('{string} saved cash is back to what it was before close', async (_c, m) => {
      const after = (await savingsFor(m as string)).savedCash;
      expect(after).toBeCloseTo(savedCashBefore);
    });
  });

  // ── FIX 1 (BLOCKER) — floor + reopen must never fabricate money ─────────
  //
  // The penalty (5.00) exceeds what "Ali" has saved (1.00), so close-week
  // floors the deduction to the available 1.00 and writes a compensating
  // 'floor' audit row. Reopening must restore exactly that 1.00 — restoring
  // the full nominal 5.00 penalty would create money from nothing.

  Scenario(
    'Reopening a floored week restores only what was actually debited, never fabricating money',
    ({ Given, And, When, Then }) => {
      Given(
        'the {string} tenant has a habit {string} for {string} with a skip penalty of {int} minor units',
        async (_c, slug, name, member, penalty: number) => {
          await seedHabit(slug as string, name as string, member as string, {
            skipPenaltyMinor: penalty,
          });
        },
      );
      And(
        '{string} has {number} saved cash and no saved stickers',
        async (_c, name, cash: number) => {
          await db.insert(mwSavings).values({
            tenantId: tenantIds['khan']!,
            memberId: memberIds[name as string]!,
            savedStickers: 0,
            savedCash: String(cash),
          });
        },
      );
      When('the caller closes the current week for {string}', async (_c, m: string) => {
        const result = await finalize(m);
        expect(result.status).toBe(200);
      });
      Then('{string} saved cash is {int}', async (_c, m, n: number) => {
        const savings = await savingsFor(m as string);
        expect(savings.savedCash).toBe(n);
      });
      When('the caller reopens that floored week for {string}', async (_c, m: string) => {
        const res = await app.request(`/api/mw/weeks?memberId=${memberIds[m as string]!}`, {
          headers: headers('khan'),
        });
        const body = (await res.json()) as { weeks: { id: string; isFinalized: boolean }[] };
        lastFinalizedWeekId = body.weeks.find((w) => w.isFinalized)?.id ?? body.weeks[0]!.id;
        const result = await reopen(m as string);
        expect(result.status).toBe(200);
      });
      Then(
        '{string} saved cash is restored to {int}, not the full nominal penalty',
        async (_c, m, n: number) => {
          const savings = await savingsFor(m as string);
          expect(savings.savedCash).toBe(n);
        },
      );
    },
  );

  // ── Tenant isolation ─────────────────────────────────────────────────────

  Scenario('reward-config is tenant-isolated', ({ Given, When, Then }) => {
    Given('a second tenant {string} exists with its own admin caller', async (_c, slug: string) => {
      await seedTenant(slug, USER2_ID);
    });
    When('the {string} caller PUTs their family rate to {int} minor units', async (_c, slug, n) => {
      const res = await app.request('/api/reward-config', {
        method: 'PUT',
        headers: headers(slug as string, token2),
        body: JSON.stringify({ familyRateMinor: n }),
      });
      expect(res.status).toBe(200);
    });
    Then('{string} family rate is still {int} minor units', async (_c, slug, n: number) => {
      const res = await app.request('/api/reward-config', { headers: headers(slug as string) });
      const body = (await res.json()) as { familyRateMinor: number };
      expect(body.familyRateMinor).toBe(n);
    });
  });
});
