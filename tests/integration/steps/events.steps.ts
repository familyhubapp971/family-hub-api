import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { eventsRouter } from '../../../apps/api/src/routes/events.js';
import { tenants, members, events, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(new URL('../features/events.feature', import.meta.url).pathname);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'events-int-kid';
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

interface EventsResponse {
  weekStart: string;
  events: Array<{
    id: string;
    date: string;
    startTime: string | null;
    endTime: string | null;
    title: string;
    notes: string | null;
    memberId: string | null;
  }>;
}

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let token: string;
  const tenantIds: Record<string, string> = {};

  Background(({ Given, And }) => {
    Given('the test Postgres has clean tenants, members, events, and users tables', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE events RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
      _resetJwksCacheForTests();
      for (const k of Object.keys(tenantIds)) delete tenantIds[k];
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
      app.route('/api/events', eventsRouter);
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

  async function getEvents(slug: string, weekStart: string) {
    const res = await app.request(`/api/events?weekStart=${weekStart}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-test-tenant': tenantIds[slug]!,
      },
    });
    const body = (await res.json()) as EventsResponse;
    return { res, body };
  }

  async function postEvent(slug: string, title: string, date: string) {
    return app.request('/api/events', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-test-tenant': tenantIds[slug]!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ date, title }),
    });
  }

  Scenario(
    'GET returns events whose date sits in the requested week',
    ({ Given, And, When, Then }) => {
      let res: Response;
      let body: EventsResponse;

      Given(
        'the {string} tenant has an event {string} on {string}',
        async (_ctx, slug: string, title: string, date: string) => {
          await db.insert(events).values({
            tenantId: tenantIds[slug]!,
            date,
            title,
          });
        },
      );

      And(
        'the {string} tenant has an event {string} on {string}',
        async (_ctx, slug: string, title: string, date: string) => {
          await db.insert(events).values({
            tenantId: tenantIds[slug]!,
            date,
            title,
          });
        },
      );

      When(
        'the caller GETs /api/events for week {string} in tenant {string}',
        async (_ctx, weekStart: string, slug: string) => {
          const out = await getEvents(slug, weekStart);
          res = out.res;
          body = out.body;
        },
      );

      Then('the GET response status is 200', () => {
        expect(res.status).toBe(200);
      });

      And('the response includes {int} events', (_ctx, n: number) => {
        expect(body.events).toHaveLength(n);
      });

      And('the response includes a {string} event', (_ctx, title: string) => {
        expect(body.events.find((e) => e.title === title)).toBeDefined();
      });
    },
  );

  Scenario('POST creates an event and GET returns it within the week', ({ When, Then, And }) => {
    let postRes: Response;

    When(
      'the caller POSTs an event {string} on {string} in tenant {string}',
      async (_ctx, title: string, date: string, slug: string) => {
        postRes = await postEvent(slug, title, date);
      },
    );

    Then('the POST response status is 201', () => {
      expect(postRes.status).toBe(201);
    });

    And(
      're-fetching events for week {string} in tenant {string} lists {int} events',
      async (_ctx, weekStart: string, slug: string, n: number) => {
        const out = await getEvents(slug, weekStart);
        expect(out.res.status).toBe(200);
        expect(out.body.events).toHaveLength(n);
      },
    );
  });

  Scenario('A child member cannot create events', ({ Given, When, Then }) => {
    let postRes: Response;

    Given("the caller's role in {string} is {string}", async (_ctx, slug: string, role: string) => {
      await db
        .update(members)
        .set({ role: role as 'admin' | 'adult' | 'teen' | 'child' | 'guest' })
        .where(sql`tenant_id = ${tenantIds[slug]!} AND user_id = ${USER_ID}`);
    });

    When(
      'the caller POSTs an event {string} on {string} in tenant {string}',
      async (_ctx, title: string, date: string, slug: string) => {
        postRes = await postEvent(slug, title, date);
      },
    );

    Then('the POST response status is 403', () => {
      expect(postRes.status).toBe(403);
    });
  });

  Scenario(
    "Tenant isolation — another tenant's events never appear",
    ({ Given, And, When, Then }) => {
      let res: Response;
      let body: EventsResponse;

      const seedEventForTenant = async (
        _ctx: unknown,
        slug: string,
        title: string,
        date: string,
      ) => {
        await db.insert(events).values({
          tenantId: tenantIds[slug]!,
          date,
          title,
        });
      };

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

      And('the {string} tenant has an event {string} on {string}', seedEventForTenant);
      And('separately the {string} tenant has an event {string} on {string}', seedEventForTenant);

      When(
        'the caller GETs /api/events for week {string} in tenant {string}',
        async (_ctx, weekStart: string, slug: string) => {
          const out = await getEvents(slug, weekStart);
          res = out.res;
          body = out.body;
        },
      );

      Then('the GET response status is 200', () => {
        expect(res.status).toBe(200);
      });

      And('the response includes {int} events', (_ctx, n: number) => {
        expect(body.events).toHaveLength(n);
      });

      And('the response includes a {string} event', (_ctx, title: string) => {
        expect(body.events.find((e) => e.title === title)).toBeDefined();
      });

      And('the response excludes a {string} event', (_ctx, title: string) => {
        expect(body.events.find((e) => e.title === title)).toBeUndefined();
      });
    },
  );
});
