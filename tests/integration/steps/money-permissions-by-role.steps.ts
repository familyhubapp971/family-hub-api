import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { mwWeeksRouter } from '../../../apps/api/src/routes/mw-weeks.js';
import { mwFinancialRouter } from '../../../apps/api/src/routes/mw-financial.js';
import { adminRouter } from '../../../apps/api/src/routes/admin.js';
import { rewardConfigRouter } from '../../../apps/api/src/routes/reward-config.js';
import { tenants, members, habits, habitStickers, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

// FHS-625: the permission matrix, proved against the real routers and real
// Postgres. The app hides doors a role cannot use; this is what makes that a
// courtesy rather than the gate. Every role is a separate signed-in user with
// their own membership row, so these are real 403s from the real guards.

const feature = await loadFeature(
  new URL('../features/money-permissions-by-role.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'money-perms-int-kid';

// One signed-in user per role, plus the child (kids can hold an account).
const ROLES = ['admin', 'adult', 'teen', 'guest', 'child'] as const;
type Role = (typeof ROLES)[number];

const USER_IDS: Record<Role, string> = {
  admin: '00000000-0000-4000-8000-000000006251',
  adult: '00000000-0000-4000-8000-000000006252',
  teen: '00000000-0000-4000-8000-000000006253',
  guest: '00000000-0000-4000-8000-000000006254',
  child: '00000000-0000-4000-8000-000000006255',
};

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

describeFeature(feature, ({ Background, Scenario, ScenarioOutline }) => {
  let db: Database;
  let app: Hono;
  const tokens: Record<string, string> = {};
  let tenantId = '';
  let childId = '';
  let otherChildId = '';
  let habitId = '';
  let weekId = '';
  let last = { status: 0, body: {} as Record<string, unknown> };

  function headersFor(role: string) {
    return {
      Authorization: `Bearer ${tokens[role]!}`,
      'x-test-tenant': tenantId,
      'Content-Type': 'application/json',
    };
  }

  async function call(
    role: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<void> {
    const res = await app.request(path, {
      method: init.method ?? 'GET',
      headers: headersFor(role),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    last = {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
  }

  // The two things this feature asserts. A refusal must be exactly 403, never
  // a 404 or a 400 that happens to keep the caller out by accident: those hide
  // a missing guard. An allowed call only has to get past the guard; what it
  // then returns is that endpoint's own feature file.
  function expectRefused() {
    expect(last.status, `expected 403, body: ${JSON.stringify(last.body)}`).toBe(403);
  }

  function expectAllowed() {
    expect(
      last.status,
      `expected to get past the guard, body: ${JSON.stringify(last.body)}`,
    ).not.toBeGreaterThanOrEqual(400);
  }

  // One place that says what each plain-English endpoint name actually hits.
  // Written as thunks so the week id is read at call time, after Background.
  async function callEndpoint(role: string, endpoint: string, memberId: string): Promise<void> {
    switch (endpoint) {
      case 'bank stickers':
        return call(role, '/api/mw/financial/savings', {
          method: 'POST',
          body: { memberId, type: 'stickers', amount: 1 },
        });
      case 'open an investment':
        return call(role, '/api/mw/financial/investments', {
          method: 'POST',
          body: { memberId, habitId, stickerCount: 10 },
        });
      case 'set a balance':
        return call(role, '/api/mw/financial/savings/admin-set', {
          method: 'PUT',
          body: { memberId, savedStickers: 5, savedCash: 0 },
        });
      case 'close the week':
        return call(role, `/api/mw/weeks/${weekId}/finalize`, {
          method: 'POST',
          body: { memberId, continueInvestmentIds: [] },
        });
      case 'reopen the week':
        return call(role, `/api/mw/weeks/${weekId}/reopen`, { method: 'POST', body: { memberId } });
      case 'edit the week cash':
        return call(role, `/api/mw/weeks/${weekId}/cash`, {
          method: 'PUT',
          body: { memberId, carriedOverCash: 1, retrievedCash: 0 },
        });
      case 'rename the family':
        return call(role, '/api/admin/settings/familyName', {
          method: 'PUT',
          body: { value: 'The Khans' },
        });
      case 'change the currency':
        return call(role, '/api/admin/settings/currency', {
          method: 'PUT',
          body: { value: 'GBP' },
        });
      case 'export our data':
        return call(role, '/api/admin/export');
      case 'change earning rules':
        return call(role, '/api/reward-config', {
          method: 'PUT',
          body: { familyRateMinor: 75 },
        });
      case 'earning rules':
        return call(role, '/api/reward-config');
      case 'the settings':
        return call(role, '/api/admin/settings');
      default:
        throw new Error(`money-permissions: no endpoint named "${endpoint}"`);
    }
  }

  Background(({ Given, And }) => {
    Given('the test Postgres has clean money-permission tables', async () => {
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
      await db.execute(
        sql`DELETE FROM users WHERE id IN (${sql.join(
          ROLES.map((r) => sql`${USER_IDS[r]}`),
          sql`, `,
        )})`,
      );
      _resetJwksCacheForTests();
      last = { status: 0, body: {} };
      otherChildId = '';
    });

    And('a users mirror row exists for every role in the money-permission test', async () => {
      for (const role of ROLES) {
        await db.execute(
          sql`INSERT INTO users (id, email) VALUES (${USER_IDS[role]}, ${`${role}@money-perms.test`})
              ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
        );
      }
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
      app.route('/api/mw/weeks', mwWeeksRouter);
      app.route('/api/mw/financial', mwFinancialRouter);
      app.route('/api/admin', adminRouter);
      app.route('/api/reward-config', rewardConfigRouter);
      for (const role of ROLES) {
        tokens[role] = await mintToken(privateKey, USER_IDS[role], `${role}@money-perms.test`);
      }
    });

    And('a family exists with an admin, an adult, a teen, a guest and a child', async () => {
      const [tenant] = await db
        .insert(tenants)
        .values({ slug: 'money-perms', name: 'Money Perms Family' })
        .returning();
      tenantId = tenant!.id;

      for (const role of ['admin', 'adult', 'teen', 'guest'] as const) {
        await db.insert(members).values({
          tenantId,
          userId: USER_IDS[role],
          displayName: `The ${role}`,
          role,
          isChild: role === 'teen',
        });
      }
      const [child] = await db
        .insert(members)
        .values({
          tenantId,
          userId: USER_IDS.child,
          displayName: 'Layla',
          role: 'child',
          isChild: true,
        })
        .returning();
      childId = child!.id;
    });

    And('the child has enough stickers to spend this week', async () => {
      const [habit] = await db
        .insert(habits)
        .values({ tenantId, memberId: childId, name: 'Brush teeth' })
        .returning();
      habitId = habit!.id;

      // Let the API open the week rather than computing this week's Monday
      // here: a hand-built row that disagrees by a day leaves the stickers on
      // an orphan week, and every money call then reads zero available.
      const res = await app.request(`/api/mw/weeks/current?memberId=${childId}`, {
        headers: headersFor('admin'),
      });
      const body = (await res.json().catch(() => ({}))) as { week?: { id: string } };
      if (!body.week) {
        throw new Error(
          `money-permissions seed: could not open the child's week (${res.status}): ${JSON.stringify(body)}`,
        );
      }
      weekId = body.week.id;

      // One sticker per day of the week, each worth 2, so the child has 14
      // sticker-value to spend: enough to bank one and to clear the
      // ten-sticker minimum an investment needs. Seven, not ten: a habit can
      // only hold one sticker per day (habit_stickers_unique).
      await db.insert(habitStickers).values(
        Array.from({ length: 7 }, (_, day) => ({
          tenantId,
          memberId: childId,
          habitId,
          weekId,
          day,
          sticker: 'gold-star' as const,
          stickerValue: 2,
        })),
      );
    });
  });

  ScenarioOutline(
    'An everyday money move is refused to anyone who is not a grown-up',
    ({ When, Then }, variables) => {
      When('"<role>" tries to "<endpoint>" for the child', async () => {
        await callEndpoint(String(variables['role']), String(variables['endpoint']), childId);
      });
      Then('the money-permission call is refused', () => expectRefused());
    },
  );

  ScenarioOutline('An everyday money move is open to any grown-up', ({ When, Then }, variables) => {
    When('"<role>" tries to "<endpoint>" for the child', async () => {
      await callEndpoint(String(variables['role']), String(variables['endpoint']), childId);
    });
    Then('the money-permission call is allowed', () => expectAllowed());
  });

  ScenarioOutline(
    'Anything that cannot be undone is refused to everyone but an admin',
    ({ When, Then }, variables) => {
      When('"<role>" tries to "<endpoint>" for the child', async () => {
        await callEndpoint(String(variables['role']), String(variables['endpoint']), childId);
      });
      Then('the money-permission call is refused', () => expectRefused());
    },
  );

  ScenarioOutline(
    'An admin may do the things that cannot be undone',
    ({ When, Then }, variables) => {
      When('"admin" tries to "<endpoint>" for the child', async () => {
        await callEndpoint('admin', String(variables['endpoint']), childId);
      });
      Then('the money-permission call is allowed', () => expectAllowed());
    },
  );

  ScenarioOutline(
    'Family-wide settings are refused to everyone but an admin',
    ({ When, Then }, variables) => {
      When('"<role>" tries to "<endpoint>"', async () => {
        await callEndpoint(String(variables['role']), String(variables['endpoint']), childId);
      });
      Then('the money-permission call is refused', () => expectRefused());
    },
  );

  ScenarioOutline('An admin may change the family-wide settings', ({ When, Then }, variables) => {
    When('"admin" tries to "<endpoint>"', async () => {
      await callEndpoint('admin', String(variables['endpoint']), childId);
    });
    Then('the money-permission call is allowed', () => expectAllowed());
  });

  ScenarioOutline(
    'Reading the settings is open to the whole family',
    ({ When, Then }, variables) => {
      When('"<role>" reads "<endpoint>"', async () => {
        await callEndpoint(String(variables['role']), String(variables['endpoint']), childId);
      });
      Then('the money-permission call is allowed', () => expectAllowed());
    },
  );

  // Reopen needs a week that is actually closed, so it cannot be a row in the
  // allowed-endpoints outline (every scenario starts from a fresh open week).
  Scenario('An admin may reopen a week they closed', ({ When, And, Then }) => {
    When('"admin" tries to "close the week" for the child', async () => {
      await callEndpoint('admin', 'close the week', childId);
      expectAllowed();
    });
    And('"admin" tries to "reopen the week" for the child', async () => {
      await callEndpoint('admin', 'reopen the week', childId);
    });
    Then('the money-permission call is allowed', () => expectAllowed());
  });

  Scenario('A child may bank their own stickers', ({ When, Then }) => {
    When('the child banks her own stickers', async () => {
      await callEndpoint('child', 'bank stickers', childId);
    });
    Then('the money-permission call is allowed', () => expectAllowed());
  });

  Scenario("A child may not touch another child's money", ({ Given, When, Then }) => {
    Given('the family has a second child', async () => {
      const [other] = await db
        .insert(members)
        .values({ tenantId, displayName: 'Omar', role: 'child', isChild: true })
        .returning();
      otherChildId = other!.id;
    });
    When('the child tries to bank stickers for the other child', async () => {
      await callEndpoint('child', 'bank stickers', otherChildId);
    });
    Then('the money-permission call is refused', () => expectRefused());
  });
});
