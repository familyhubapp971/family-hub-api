import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql, eq } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { habitsRouter } from '../../../apps/api/src/routes/habits.js';
import { mwWeeksRouter } from '../../../apps/api/src/routes/mw-weeks.js';
import { mwFinancialRouter } from '../../../apps/api/src/routes/mw-financial.js';
import { adminRouter } from '../../../apps/api/src/routes/admin.js';
import { tenants, members, habits, mwWeeks, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(
  new URL('../features/admin-panel.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'admin-panel-int-kid';
const USER_ID = '00000000-0000-4000-8000-000000000308';
const USER_EMAIL = 'adminpanel@example.com';

// A second user for guest role testing.
const GUEST_USER_ID = '00000000-0000-4000-8000-000000003082';
const GUEST_USER_EMAIL = 'guestpanel@example.com';

async function genKey() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = 'ES256';
  publicJwk.kid = KID;
  publicJwk.use = 'sig';
  return { privateKey, publicJwk };
}

async function mintToken(privateKey: KeyLike, userId: string, email: string) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setSubject(userId)
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
  let guestToken: string;
  const tenantIds: Record<string, string> = {};
  const memberIds: Record<string, string> = {};
  const habitIds: Record<string, string> = {};

  // Last HTTP response state, one per "topic".
  let lastSettings: { status: number; body: Record<string, unknown> };
  let lastSettingsPut: { status: number; body: Record<string, unknown> };
  let lastAdminSet: { status: number; body: Record<string, unknown> };
  let lastCashEdit: { status: number; body: Record<string, unknown> };
  let lastReopen: { status: number; body: Record<string, unknown> };
  let lastRepair: { status: number; body: Record<string, unknown> };
  let lastActions: { status: number; body: Record<string, unknown> };
  let lastFinalize: { status: number; body: Record<string, unknown> };

  // Helpers —————————————————————————————————————————————————————————————————

  function headers(slug: string, forUserId = USER_ID) {
    const t = forUserId === GUEST_USER_ID ? guestToken : token;
    return {
      Authorization: `Bearer ${t}`,
      'x-test-tenant': tenantIds[slug]!,
      'Content-Type': 'application/json',
    };
  }

  async function currentWeekId(memberName: string, slug = 'jones'): Promise<string> {
    const res = await app.request(`/api/mw/weeks/current?memberId=${memberIds[memberName]!}`, {
      headers: headers(slug),
    });
    const body = (await res.json()) as { week: { id: string } };
    return body.week.id;
  }

  async function placeSticker(habitName: string, memberName: string, day: number) {
    const weekId = await currentWeekId(memberName);
    return app.request(`/api/habits/${habitIds[habitName]!}/stickers`, {
      method: 'POST',
      headers: headers('jones'),
      body: JSON.stringify({ memberId: memberIds[memberName]!, weekId, day, sticker: 'gold-star' }),
    });
  }

  async function finalize(memberName: string) {
    const weekId = await currentWeekId(memberName);
    const res = await app.request(`/api/mw/weeks/${weekId}/finalize`, {
      method: 'POST',
      headers: headers('jones'),
      body: JSON.stringify({ memberId: memberIds[memberName]!, continueInvestmentIds: [] }),
    });
    lastFinalize = {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
    return lastFinalize;
  }

  async function finalizedWeekId(memberName: string): Promise<string> {
    const res = await app.request(`/api/mw/weeks?memberId=${memberIds[memberName]!}`, {
      headers: headers('jones'),
    });
    const body = (await res.json()) as { weeks: { id: string; isFinalized: boolean }[] };
    const finalized = body.weeks.find((w) => w.isFinalized);
    return finalized?.id ?? body.weeks[0]!.id;
  }

  async function savedStickers(memberName: string): Promise<number> {
    const res = await app.request(`/api/mw/financial/savings?memberId=${memberIds[memberName]!}`, {
      headers: headers('jones'),
    });
    const body = (await res.json()) as { savedStickers: number };
    return body.savedStickers;
  }

  async function savedCash(memberName: string): Promise<number> {
    const res = await app.request(`/api/mw/financial/savings?memberId=${memberIds[memberName]!}`, {
      headers: headers('jones'),
    });
    const body = (await res.json()) as { savedCash: number };
    return Number(body.savedCash);
  }

  async function activeInvestmentCount(memberName: string): Promise<number> {
    const res = await app.request(
      `/api/mw/financial/investments?memberId=${memberIds[memberName]!}`,
      { headers: headers('jones') },
    );
    const body = (await res.json()) as { investments: unknown[] };
    return body.investments.length;
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
  }

  async function seedGuest(slug: string, name: string) {
    const [row] = await db
      .insert(members)
      .values({
        tenantId: tenantIds[slug]!,
        userId: GUEST_USER_ID,
        displayName: name,
        role: 'guest',
      })
      .returning();
    memberIds[name] = row!.id;
  }

  async function seedHabit(slug: string, name: string, memberName: string, isBonus: boolean) {
    // FHS-512 — stickerValue comes from `boost` now; set it explicitly since
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

  // Background ——————————————————————————————————————————————————————————————

  Background(({ Given, And }) => {
    Given('the test Postgres has clean admin-panel tables', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE mw_transaction_stickers RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE mw_savings_transactions RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE mw_week_actions RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE mw_investments RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE mw_savings RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE habit_stickers RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE mw_weeks RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE app_settings RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE habits RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${USER_ID}, ${GUEST_USER_ID})`);
      _resetJwksCacheForTests();
      for (const m of [tenantIds, memberIds, habitIds]) {
        for (const k of Object.keys(m)) delete m[k];
      }
    });

    And('a users mirror row exists for the admin-panel test caller', async () => {
      await db.execute(
        sql`INSERT INTO users (id, email) VALUES (${USER_ID}, ${USER_EMAIL})
            ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      );
      await db.execute(
        sql`INSERT INTO users (id, email) VALUES (${GUEST_USER_ID}, ${GUEST_USER_EMAIL})
            ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      );
      const { privateKey, publicJwk } = await genKey();
      app = new Hono();
      app.use(
        '*',
        authMiddleware({
          issuer: ISSUER,
          jwks: makeJwks(publicJwk),
          userMirrorSync: async (claims) => {
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
      app.route('/api/admin', adminRouter);
      token = await mintToken(privateKey, USER_ID, USER_EMAIL);
      guestToken = await mintToken(privateKey, GUEST_USER_ID, GUEST_USER_EMAIL);
    });

    And(
      'an admin-panel tenant {string} exists with the caller as an admin member',
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

    And(
      'the {string} tenant has a bonus habit {string} for {string}',
      async (_c, slug: string, name: string, member: string) => {
        await seedHabit(slug, name, member, true);
      },
    );
  });

  // Scenario: Settings GET returns an empty map ————————————————————————————

  Scenario('Settings GET returns an empty map for a fresh tenant', ({ When, Then, And }) => {
    When('the caller fetches settings for tenant {string}', async (_c, slug: string) => {
      const res = await app.request('/api/admin/settings', { headers: headers(slug) });
      lastSettings = {
        status: res.status,
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
      };
    });
    Then('the settings response status is {int}', (_c, n: number) =>
      expect(lastSettings.status).toBe(n),
    );
    And('the settings map is empty', () => {
      // FHS-441 — currency is always present (defaults to USD), so
      // "empty" means no custom app_settings keys have been saved yet.
      const { currency, ...customKeys } = lastSettings.body as Record<string, unknown>;
      expect(Object.keys(customKeys)).toHaveLength(0);
      expect(currency).toBe('USD');
    });
  });

  // Scenario: Settings PUT round-trip —————————————————————————————————————

  Scenario('Settings PUT round-trip stores and retrieves a value', ({ When, Then, And }) => {
    When(
      'the caller puts setting {string} to {string} for tenant {string}',
      async (_c, key: string, value: string, slug: string) => {
        const res = await app.request(`/api/admin/settings/${key}`, {
          method: 'PUT',
          headers: headers(slug),
          body: JSON.stringify({ value }),
        });
        lastSettingsPut = {
          status: res.status,
          body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
        };
      },
    );
    Then('the settings put response status is {int}', (_c, n: number) =>
      expect(lastSettingsPut.status).toBe(n),
    );
    And('the caller fetches settings for tenant {string}', async (_c, slug: string) => {
      const res = await app.request('/api/admin/settings', { headers: headers(slug) });
      lastSettings = {
        status: res.status,
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
      };
    });
    And('the settings map has {string} equal to {string}', (_c, key: string, value: string) => {
      expect(lastSettings.body[key]).toBe(value);
    });
  });

  // Scenario: Settings are tenant-scoped ——————————————————————————————————

  Scenario(
    'Settings PUT is tenant-scoped (other tenants do not see it)',
    ({ Given, When, Then, And }) => {
      Given(
        'an admin-panel tenant {string} exists with the caller as an admin member',
        async (_c, slug: string) => {
          await seedTenant(slug);
        },
      );
      When(
        'the caller puts setting {string} to {string} for tenant {string}',
        async (_c, key: string, value: string, slug: string) => {
          const res = await app.request(`/api/admin/settings/${key}`, {
            method: 'PUT',
            headers: headers(slug),
            body: JSON.stringify({ value }),
          });
          lastSettingsPut = {
            status: res.status,
            body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
          };
        },
      );
      And('the caller fetches settings for tenant {string}', async (_c, slug: string) => {
        const res = await app.request('/api/admin/settings', { headers: headers(slug) });
        lastSettings = {
          status: res.status,
          body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
        };
      });
      Then('the settings map is empty', () => {
        const { currency, ...customKeys } = lastSettings.body as Record<string, unknown>;
        expect(Object.keys(customKeys)).toHaveLength(0);
        expect(currency).toBe('USD');
      });
    },
  );

  // Scenario: FHS-441 — currency PUT round-trips through tenants.currency ——

  Scenario(
    'FHS-441 — currency PUT updates tenants.currency and GET reflects it',
    ({ When, Then, And }) => {
      When(
        'the caller puts setting {string} to {string} for tenant {string}',
        async (_c, key: string, value: string, slug: string) => {
          const res = await app.request(`/api/admin/settings/${key}`, {
            method: 'PUT',
            headers: headers(slug),
            body: JSON.stringify({ value }),
          });
          lastSettingsPut = {
            status: res.status,
            body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
          };
        },
      );
      Then('the settings put response status is {int}', (_c, n: number) =>
        expect(lastSettingsPut.status).toBe(n),
      );
      And('the caller fetches settings for tenant {string}', async (_c, slug: string) => {
        const res = await app.request('/api/admin/settings', { headers: headers(slug) });
        lastSettings = {
          status: res.status,
          body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
        };
      });
      And('the settings map has {string} equal to {string}', (_c, key: string, value: string) => {
        expect(lastSettings.body[key]).toBe(value);
      });
    },
  );

  // Scenario: FHS-441 — invalid currency codes are rejected —————————————————

  Scenario('FHS-441 — currency PUT rejects an invalid ISO code', ({ When, Then }) => {
    When(
      'the caller puts setting {string} to {string} for tenant {string}',
      async (_c, key: string, value: string, slug: string) => {
        const res = await app.request(`/api/admin/settings/${key}`, {
          method: 'PUT',
          headers: headers(slug),
          body: JSON.stringify({ value }),
        });
        lastSettingsPut = {
          status: res.status,
          body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
        };
      },
    );
    Then('the settings put response status is {int}', (_c, n: number) =>
      expect(lastSettingsPut.status).toBe(n),
    );
  });

  // Scenario: FHS-441 — currency is tenant-scoped ———————————————————————————

  Scenario(
    'FHS-441 — currency is tenant-scoped (other tenants keep their own)',
    ({ Given, When, Then, And }) => {
      Given(
        'an admin-panel tenant {string} exists with the caller as an admin member',
        async (_c, slug: string) => {
          await seedTenant(slug);
        },
      );
      When(
        'the caller puts setting {string} to {string} for tenant {string}',
        async (_c, key: string, value: string, slug: string) => {
          const res = await app.request(`/api/admin/settings/${key}`, {
            method: 'PUT',
            headers: headers(slug),
            body: JSON.stringify({ value }),
          });
          lastSettingsPut = {
            status: res.status,
            body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
          };
        },
      );
      And('the caller fetches settings for tenant {string}', async (_c, slug: string) => {
        const res = await app.request('/api/admin/settings', { headers: headers(slug) });
        lastSettings = {
          status: res.status,
          body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
        };
      });
      Then('the settings map has {string} equal to {string}', (_c, key: string, value: string) => {
        expect(lastSettings.body[key]).toBe(value);
      });
    },
  );

  // Scenario: Admin savings-set ———————————————————————————————————————————

  Scenario('Admin savings-set overwrites the balance', ({ Given, When, Then, And }) => {
    Given(
      'the caller places a sticker on {string} day {int} for {string}',
      async (_c, h: string, day: number, m: string) => {
        await placeSticker(h, m, day);
      },
    );
    And(
      'the caller saves {int} stickers for {string} in tenant {string}',
      async (_c, n: number, memberName: string) => {
        const week = await currentWeekId(memberName);
        await app.request('/api/mw/financial/savings', {
          method: 'POST',
          headers: headers('jones'),
          body: JSON.stringify({ memberId: memberIds[memberName]!, type: 'stickers', amount: n }),
        });
        void week; // week var not used; just invoking save
      },
    );
    When(
      'the caller admin-sets {string} savings to {int} stickers and {string} cash',
      async (_c, memberName: string, stickers: number, cashStr: string) => {
        const cash = parseFloat(cashStr);
        const res = await app.request('/api/mw/financial/savings/admin-set', {
          method: 'PUT',
          headers: headers('jones'),
          body: JSON.stringify({
            memberId: memberIds[memberName]!,
            savedStickers: stickers,
            savedCash: cash,
          }),
        });
        lastAdminSet = {
          status: res.status,
          body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
        };
      },
    );
    Then('the admin-set response status is {int}', (_c, n: number) =>
      expect(lastAdminSet.status).toBe(n),
    );
    And(
      '{string} has {int} saved stickers in tenant {string}',
      async (_c, memberName: string, n: number) => {
        expect(await savedStickers(memberName)).toBe(n);
      },
    );
    And(
      '{string} has {string} saved cash in tenant {string}',
      async (_c, memberName: string, cashStr: string) => {
        expect(await savedCash(memberName)).toBeCloseTo(parseFloat(cashStr), 2);
      },
    );
  });

  // Scenario: Week cash edit —————————————————————————————————————————————

  Scenario('Week cash edit persists carriedOverCash and retrievedCash', ({ When, Then, And }) => {
    When(
      'the caller edits the current week cash for {string} to carriedOverCash {int} and retrievedCash {int}',
      async (_c, memberName: string, coc: number, rc: number) => {
        const weekId = await currentWeekId(memberName);
        const res = await app.request(`/api/mw/weeks/${weekId}/cash`, {
          method: 'PUT',
          headers: headers('jones'),
          body: JSON.stringify({
            memberId: memberIds[memberName]!,
            carriedOverCash: coc,
            retrievedCash: rc,
          }),
        });
        lastCashEdit = {
          status: res.status,
          body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
        };
      },
    );
    Then('the cash-edit response status is {int}', (_c, n: number) =>
      expect(lastCashEdit.status).toBe(n),
    );
    And(
      'the cash-edit response week has carriedOverCash {int} and retrievedCash {int}',
      (_c, coc: number, rc: number) => {
        const week = lastCashEdit.body['week'] as Record<string, unknown>;
        expect(Number(week?.['carriedOverCash'])).toBeCloseTo(coc, 2);
        expect(Number(week?.['retrievedCash'])).toBeCloseTo(rc, 2);
      },
    );
  });

  // Scenario: Reopen round-trip ———————————————————————————————————————————

  Scenario(
    'Reopen round-trips finalize — stickers reversed, investment restored',
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
          const res = await app.request('/api/mw/financial/investments', {
            method: 'POST',
            headers: headers('jones'),
            body: JSON.stringify({
              memberId: memberIds[m]!,
              habitId: habitIds[h]!,
              stickerCount: n,
            }),
          });
          expect(res.status).toBe(201);
        },
      );
      And('the caller finalizes the current week for {string}', async (_c, m: string) => {
        await finalize(m);
        expect(lastFinalize.status).toBe(200);
      });
      When('the caller reopens the current finalized week for {string}', async (_c, m: string) => {
        const weekId = await finalizedWeekId(m);
        const res = await app.request(`/api/mw/weeks/${weekId}/reopen`, {
          method: 'POST',
          headers: headers('jones'),
          body: JSON.stringify({ memberId: memberIds[m]! }),
        });
        lastReopen = {
          status: res.status,
          body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
        };
      });
      Then('the reopen response status is {int}', (_c, n: number) =>
        expect(lastReopen.status).toBe(n),
      );
      And('the reopen response shows reopened true', () =>
        expect(lastReopen.body['reopened']).toBe(true),
      );
      And('{string} has {int} saved stickers after reopen', async (_c, m: string, n: number) => {
        expect(await savedStickers(m)).toBe(n);
      });
      And(
        '{string} has {int} active investments after reopen',
        async (_c, m: string, n: number) => {
          expect(await activeInvestmentCount(m)).toBe(n);
        },
      );
    },
  );

  // Scenario: Reopen on open week returns 409 ——————————————————————————————

  Scenario('Reopen on an already-open week returns 409', ({ When, Then }) => {
    When(
      'the caller reopens the current week for {string} without finalizing',
      async (_c, m: string) => {
        const weekId = await currentWeekId(m);
        const res = await app.request(`/api/mw/weeks/${weekId}/reopen`, {
          method: 'POST',
          headers: headers('jones'),
          body: JSON.stringify({ memberId: memberIds[m]! }),
        });
        lastReopen = {
          status: res.status,
          body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
        };
      },
    );
    Then('the reopen response status is {int}', (_c, n: number) =>
      expect(lastReopen.status).toBe(n),
    );
  });

  // Scenario: Repair ——————————————————————————————————————————————————————

  Scenario('Repair reverses leftover effects on an open week', ({ Given, And, When, Then }) => {
    Given(
      'the caller places a sticker on {string} day {int} for {string}',
      async (_c, h: string, day: number, m: string) => {
        await placeSticker(h, m, day);
      },
    );
    And('the caller finalizes the current week for {string}', async (_c, m: string) => {
      await finalize(m);
      expect(lastFinalize.status).toBe(200);
    });
    And('the caller directly reopens the week without reversal', async () => {
      // Simulate a legacy reopen that only flipped is_finalized but didn't
      // reverse sticker/savings effects — just flip the flag directly in DB.
      const [week] = await db
        .select({ id: mwWeeks.id })
        .from(mwWeeks)
        .where(eq(mwWeeks.isFinalized, true))
        .limit(1);
      if (week) {
        await db.update(mwWeeks).set({ isFinalized: false }).where(eq(mwWeeks.id, week.id));
      }
    });
    When('the caller repairs the reopened week for {string}', async (_c, m: string) => {
      // Fetch the first non-finalized week (the one we just un-flagged).
      const res = await app.request(`/api/mw/weeks?memberId=${memberIds[m]!}`, {
        headers: headers('jones'),
      });
      const body = (await res.json()) as { weeks: { id: string; isFinalized: boolean }[] };
      const openWeek = body.weeks.find((w) => !w.isFinalized);
      const weekId = openWeek?.id ?? body.weeks[0]!.id;
      const repairRes = await app.request(`/api/mw/weeks/${weekId}/repair`, {
        method: 'POST',
        headers: headers('jones'),
        body: JSON.stringify({ memberId: memberIds[m]! }),
      });
      lastRepair = {
        status: repairRes.status,
        body: (await repairRes.json().catch(() => ({}))) as Record<string, unknown>,
      };
    });
    Then('the repair response status is {int}', (_c, n: number) =>
      expect(lastRepair.status).toBe(n),
    );
    And('the repair response shows repaired true', () =>
      expect(lastRepair.body['repaired']).toBe(true),
    );
  });

  // Scenario: Guest caller rejected —————————————————————————————————————

  Scenario('A child caller is rejected on savings admin-set', ({ Given, When, Then }) => {
    Given(
      'the {string} tenant has a guest member {string}',
      async (_c, slug: string, name: string) => {
        await seedGuest(slug, name);
      },
    );
    When('a guest caller tries to admin-set {string} savings', async (_c, memberName: string) => {
      const res = await app.request('/api/mw/financial/savings/admin-set', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${guestToken}`,
          'x-test-tenant': tenantIds['jones']!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          memberId: memberIds[memberName]!,
          savedStickers: 10,
          savedCash: 0,
        }),
      });
      lastAdminSet = {
        status: res.status,
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
      };
    });
    Then('the admin-set guest response status is {int}', (_c, n: number) =>
      expect(lastAdminSet.status).toBe(n),
    );
  });

  // Scenario: Week actions GET ——————————————————————————————————————————

  Scenario('Week actions GET returns actions newest first', ({ Given, And, When, Then }) => {
    Given(
      'the caller places a sticker on {string} day {int} for {string}',
      async (_c, h: string, day: number, m: string) => {
        await placeSticker(h, m, day);
      },
    );
    And('the caller finalizes the current week for {string}', async (_c, m: string) => {
      await finalize(m);
      expect(lastFinalize.status).toBe(200);
    });
    When('the caller fetches actions for the finalized week of {string}', async (_c, m: string) => {
      const weekId = await finalizedWeekId(m);
      const res = await app.request(`/api/mw/weeks/${weekId}/actions?memberId=${memberIds[m]!}`, {
        headers: headers('jones'),
      });
      lastActions = {
        status: res.status,
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
      };
    });
    Then('the actions response status is {int}', (_c, n: number) =>
      expect(lastActions.status).toBe(n),
    );
    And('the actions list contains an auto_save entry', () => {
      const actions = lastActions.body['actions'] as Array<{ actionType: string }>;
      expect(actions.some((a) => a.actionType === 'auto_save')).toBe(true);
    });
  });
});
