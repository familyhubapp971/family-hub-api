import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { mealsRouter } from '../../../apps/api/src/routes/meals.js';
import { tenants, members, mealTemplates, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(new URL('../features/meals.feature', import.meta.url).pathname);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'meals-int-kid';
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
  const tenantId = c.req.header('x-test-tenant');
  c.set('tenantId', tenantId);
  await next();
};

interface MealsResponse {
  meals: Array<{ id: string; dayOfWeek: string; slot: string; name: string }>;
}

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let token: string;
  const tenantIds: Record<string, string> = {};

  Background(({ Given, And }) => {
    Given(
      'the test Postgres has clean tenants, members, meal_templates, and users tables',
      async () => {
        db = getTestDb() as unknown as Database;
        await db.execute(sql`TRUNCATE TABLE meal_templates RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
        await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
        _resetJwksCacheForTests();
        for (const k of Object.keys(tenantIds)) delete tenantIds[k];
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
      app.route('/api/meals', mealsRouter);
      token = await mintToken(privateKey);
    });

    And(
      'a tenant {string} exists with the caller as an admin member',
      async (_ctx, slug: string) => {
        const inserted = await db
          .insert(tenants)
          .values({ slug, name: `${slug} Family` })
          .returning();
        const tenant = inserted[0]!;
        tenantIds[slug] = tenant.id;
        await db.insert(members).values({
          tenantId: tenant.id,
          userId: USER_ID,
          displayName: 'Caller',
          role: 'admin',
        });
      },
    );
  });

  // Helpers shared across scenarios.
  async function getMeals(slug: string): Promise<{ res: Response; body: MealsResponse }> {
    const res = await app.request('/api/meals', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-test-tenant': tenantIds[slug]!,
      },
    });
    const body = (await res.json()) as MealsResponse;
    return { res, body };
  }

  async function postMeal(
    slug: string,
    dayOfWeek: string,
    slot: string,
    name: string,
  ): Promise<Response> {
    return app.request('/api/meals', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-test-tenant': tenantIds[slug]!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ dayOfWeek, slot, name }),
    });
  }

  Scenario('GET returns an empty list when nothing has been planned', ({ When, Then, And }) => {
    let res: Response;
    let body: MealsResponse;

    When('the caller GETs /api/meals for tenant {string}', async (_ctx, slug: string) => {
      const out = await getMeals(slug);
      res = out.res;
      body = out.body;
    });

    Then('the response status is 200', () => {
      expect(res.status).toBe(200);
    });

    And('the response lists {int} meals', (_ctx, n: number) => {
      expect(body.meals).toHaveLength(n);
    });
  });

  Scenario('POST upserts a meal cell, GET returns it', ({ When, Then, And }) => {
    let postRes: Response;
    let body: MealsResponse;

    When(
      'the caller POSTs a meal {string} for {string} {string} in tenant {string}',
      async (_ctx, name: string, day: string, slot: string, slug: string) => {
        postRes = await postMeal(slug, day, slot, name);
      },
    );

    Then('the POST response status is 200', () => {
      expect(postRes.status).toBe(200);
    });

    And(
      're-fetching /api/meals for tenant {string} lists {int} meals',
      async (_ctx, slug: string, n: number) => {
        const out = await getMeals(slug);
        expect(out.res.status).toBe(200);
        body = out.body;
        expect(body.meals).toHaveLength(n);
      },
    );

    And(
      'the response includes {string} for {string} {string}',
      (_ctx, name: string, day: string, slot: string) => {
        const cell = body.meals.find((m) => m.dayOfWeek === day && m.slot === slot);
        expect(cell, `${day} ${slot} cell missing`).toBeDefined();
        expect(cell!.name).toBe(name);
      },
    );
  });

  Scenario('POST upserting the same cell replaces the previous value', ({ When, Then, And }) => {
    let body: MealsResponse;

    const postOnce = async (
      _ctx: unknown,
      name: string,
      day: string,
      slot: string,
      slug: string,
    ) => {
      await postMeal(slug, day, slot, name);
    };

    When('the caller POSTs a meal {string} for {string} {string} in tenant {string}', postOnce);

    And('the caller POSTs a meal {string} for {string} {string} in tenant {string}', postOnce);

    Then(
      're-fetching /api/meals for tenant {string} lists {int} meals',
      async (_ctx, slug: string, n: number) => {
        const out = await getMeals(slug);
        expect(out.res.status).toBe(200);
        body = out.body;
        expect(body.meals).toHaveLength(n);
      },
    );

    And(
      'the response includes {string} for {string} {string}',
      (_ctx, name: string, day: string, slot: string) => {
        const cell = body.meals.find((m) => m.dayOfWeek === day && m.slot === slot);
        expect(cell).toBeDefined();
        expect(cell!.name).toBe(name);
      },
    );
  });

  Scenario('POST with empty name deletes the cell', ({ Given, When, Then, And }) => {
    let postRes: Response;

    Given(
      'the {string} tenant has a meal {string} planned for {string} {string}',
      async (_ctx, slug: string, name: string, day: string, slot: string) => {
        await db.insert(mealTemplates).values({
          tenantId: tenantIds[slug]!,
          dayOfWeek: day as 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun',
          slot: slot as 'breakfast' | 'lunch' | 'dinner' | 'snack',
          name,
        });
      },
    );

    When(
      'the caller POSTs a meal {string} for {string} {string} in tenant {string}',
      async (_ctx, name: string, day: string, slot: string, slug: string) => {
        postRes = await postMeal(slug, day, slot, name);
      },
    );

    Then('the POST response status is 200', () => {
      expect(postRes.status).toBe(200);
    });

    And(
      're-fetching /api/meals for tenant {string} lists {int} meals',
      async (_ctx, slug: string, n: number) => {
        const out = await getMeals(slug);
        expect(out.res.status).toBe(200);
        expect(out.body.meals).toHaveLength(n);
      },
    );
  });

  Scenario('A child member cannot write to the plan', ({ Given, When, Then }) => {
    let res: Response;

    Given("the caller's role in {string} is {string}", async (_ctx, slug: string, role: string) => {
      await db
        .update(members)
        .set({ role: role as 'admin' | 'adult' | 'teen' | 'child' | 'guest' })
        .where(sql`tenant_id = ${tenantIds[slug]!} AND user_id = ${USER_ID}`);
    });

    When(
      'the caller POSTs a meal {string} for {string} {string} in tenant {string}',
      async (_ctx, name: string, day: string, slot: string, slug: string) => {
        res = await postMeal(slug, day, slot, name);
      },
    );

    Then('the response status is 403', () => {
      expect(res.status).toBe(403);
    });
  });

  Scenario('Tenant isolation — meals never leak across tenants', ({ Given, And, When, Then }) => {
    let res: Response;
    let body: MealsResponse;

    Given(
      'a second tenant {string} exists with the caller as an admin member',
      async (_ctx, slug: string) => {
        const inserted = await db
          .insert(tenants)
          .values({ slug, name: `${slug} Family` })
          .returning();
        const tenant = inserted[0]!;
        tenantIds[slug] = tenant.id;
        await db.insert(members).values({
          tenantId: tenant.id,
          userId: USER_ID,
          displayName: 'Caller',
          role: 'admin',
        });
      },
    );

    And(
      'the {string} tenant has a meal {string} planned for {string} {string}',
      async (_ctx, slug: string, name: string, day: string, slot: string) => {
        await db.insert(mealTemplates).values({
          tenantId: tenantIds[slug]!,
          dayOfWeek: day as 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun',
          slot: slot as 'breakfast' | 'lunch' | 'dinner' | 'snack',
          name,
        });
      },
    );

    When('the caller GETs /api/meals for tenant {string}', async (_ctx, slug: string) => {
      const out = await getMeals(slug);
      res = out.res;
      body = out.body;
    });

    Then('the response status is 200', () => {
      expect(res.status).toBe(200);
    });

    And('the response lists {int} meals', (_ctx, n: number) => {
      expect(body.meals).toHaveLength(n);
    });
  });
});
