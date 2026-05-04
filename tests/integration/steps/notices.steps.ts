import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { noticesRouter } from '../../../apps/api/src/routes/notices.js';
import { tenants, members, notices, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(new URL('../features/notices.feature', import.meta.url).pathname);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'notices-int-kid';
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

interface ListResponse {
  notices: Array<{ id: string; body: string; pinned: boolean; createdAt: string }>;
}

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let token: string;
  const tenantIds: Record<string, string> = {};
  const noticeIds: Record<string, string> = {};

  Background(({ Given, And }) => {
    Given('the test Postgres has clean tenants, members, notices, and users tables', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE notices RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
      _resetJwksCacheForTests();
      for (const k of Object.keys(tenantIds)) delete tenantIds[k];
      for (const k of Object.keys(noticeIds)) delete noticeIds[k];
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
      app.route('/api/notices', noticesRouter);
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

  async function getNotices(slug: string) {
    const res = await app.request('/api/notices', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'x-test-tenant': tenantIds[slug]! },
    });
    const body = (await res.json()) as ListResponse;
    return { res, body };
  }

  async function postNotice(slug: string, noticeBody: string, pinned: boolean) {
    return app.request('/api/notices', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-test-tenant': tenantIds[slug]!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: noticeBody, pinned }),
    });
  }

  async function deleteNotice(slug: string, id: string) {
    return app.request(`/api/notices/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'x-test-tenant': tenantIds[slug]! },
    });
  }

  Scenario(
    'GET orders pinned notices first, then by newest createdAt',
    ({ Given, And, When, Then }) => {
      let res: Response;
      let body: ListResponse;

      const seedNotice = async (_ctx: unknown, slug: string, noticeBody: string, iso: string) => {
        const [row] = await db
          .insert(notices)
          .values({
            tenantId: tenantIds[slug]!,
            body: noticeBody,
            pinned: false,
            createdAt: new Date(iso),
            updatedAt: new Date(iso),
          })
          .returning();
        noticeIds[noticeBody] = row!.id;
      };

      const seedPinned = async (_ctx: unknown, slug: string, noticeBody: string, iso: string) => {
        const [row] = await db
          .insert(notices)
          .values({
            tenantId: tenantIds[slug]!,
            body: noticeBody,
            pinned: true,
            createdAt: new Date(iso),
            updatedAt: new Date(iso),
          })
          .returning();
        noticeIds[noticeBody] = row!.id;
      };

      Given('the {string} tenant has a notice {string} posted at {string}', seedNotice);
      And(
        'separately the {string} tenant has a pinned notice {string} posted at {string}',
        seedPinned,
      );
      And('separately the {string} tenant has a notice {string} posted at {string}', seedNotice);

      When('the caller GETs /api/notices for tenant {string}', async (_ctx, slug: string) => {
        const out = await getNotices(slug);
        res = out.res;
        body = out.body;
      });

      Then('the GET response status is 200', () => {
        expect(res.status).toBe(200);
      });

      And('the response includes {int} notices', (_ctx, n: number) => {
        expect(body.notices).toHaveLength(n);
      });

      And('the first notice body is {string}', (_ctx, b: string) => {
        expect(body.notices[0]?.body).toBe(b);
      });

      And('the second notice body is {string}', (_ctx, b: string) => {
        expect(body.notices[1]?.body).toBe(b);
      });
    },
  );

  Scenario('POST creates a notice; GET returns it', ({ When, Then, And }) => {
    let postRes: Response;

    When(
      'the caller POSTs a notice {string} pinned {string} in tenant {string}',
      async (_ctx, b: string, pinnedStr: string, slug: string) => {
        postRes = await postNotice(slug, b, pinnedStr === 'true');
      },
    );

    Then('the POST response status is 201', () => {
      expect(postRes.status).toBe(201);
    });

    And(
      're-fetching /api/notices for tenant {string} lists {int} notices',
      async (_ctx, slug: string, n: number) => {
        const out = await getNotices(slug);
        expect(out.res.status).toBe(200);
        expect(out.body.notices).toHaveLength(n);
      },
    );
  });

  Scenario('A child member cannot post a notice', ({ Given, When, Then }) => {
    let postRes: Response;

    Given("the caller's role in {string} is {string}", async (_ctx, slug: string, role: string) => {
      await db
        .update(members)
        .set({ role: role as 'admin' | 'adult' | 'teen' | 'child' | 'guest' })
        .where(sql`tenant_id = ${tenantIds[slug]!} AND user_id = ${USER_ID}`);
    });

    When(
      'the caller POSTs a notice {string} pinned {string} in tenant {string}',
      async (_ctx, b: string, pinned: string, slug: string) => {
        postRes = await postNotice(slug, b, pinned === 'true');
      },
    );

    Then('the POST response status is 403', () => {
      expect(postRes.status).toBe(403);
    });
  });

  Scenario('DELETE removes the notice idempotently', ({ Given, When, Then, And }) => {
    let delRes: Response;

    Given(
      'the {string} tenant has a notice {string} posted at {string}',
      async (_ctx, slug: string, b: string, iso: string) => {
        const [row] = await db
          .insert(notices)
          .values({
            tenantId: tenantIds[slug]!,
            body: b,
            pinned: false,
            createdAt: new Date(iso),
            updatedAt: new Date(iso),
          })
          .returning();
        noticeIds[b] = row!.id;
      },
    );

    When('the caller deletes that notice in tenant {string}', async (_ctx, slug: string) => {
      delRes = await deleteNotice(slug, noticeIds['Pizza Friday']!);
    });

    Then('the DELETE response status is 204', () => {
      expect(delRes.status).toBe(204);
    });

    And(
      're-fetching /api/notices for tenant {string} lists {int} notices',
      async (_ctx, slug: string, n: number) => {
        const out = await getNotices(slug);
        expect(out.res.status).toBe(200);
        expect(out.body.notices).toHaveLength(n);
      },
    );
  });

  Scenario(
    "Tenant isolation — another tenant's notices never appear",
    ({ Given, And, When, Then }) => {
      let res: Response;
      let body: ListResponse;

      const seedNotice = async (_ctx: unknown, slug: string, b: string, iso: string) => {
        const [row] = await db
          .insert(notices)
          .values({
            tenantId: tenantIds[slug]!,
            body: b,
            pinned: false,
            createdAt: new Date(iso),
            updatedAt: new Date(iso),
          })
          .returning();
        noticeIds[b] = row!.id;
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

      And('the {string} tenant has a notice {string} posted at {string}', seedNotice);
      And('separately the {string} tenant has a notice {string} posted at {string}', seedNotice);

      When('the caller GETs /api/notices for tenant {string}', async (_ctx, slug: string) => {
        const out = await getNotices(slug);
        res = out.res;
        body = out.body;
      });

      Then('the GET response status is 200', () => {
        expect(res.status).toBe(200);
      });

      And('the response includes {int} notices', (_ctx, n: number) => {
        expect(body.notices).toHaveLength(n);
      });

      And('the first notice body is {string}', (_ctx, b: string) => {
        expect(body.notices[0]?.body).toBe(b);
      });
    },
  );
});
