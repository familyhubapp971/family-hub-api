import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { assignmentsRouter } from '../../../apps/api/src/routes/assignments.js';
import { tenants, members, assignments, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(
  new URL('../features/assignments.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'assignments-int-kid';
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
  assignments: Array<{
    id: string;
    title: string;
    dueDate: string | null;
    done: boolean;
    doneAt: string | null;
  }>;
}

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let token: string;
  const tenantIds: Record<string, string> = {};
  // Stable map title→id so PATCH scenarios can find the row.
  const assignmentIds: Record<string, string> = {};

  Background(({ Given, And }) => {
    Given(
      'the test Postgres has clean tenants, members, assignments, and users tables',
      async () => {
        db = getTestDb() as unknown as Database;
        await db.execute(sql`TRUNCATE TABLE assignments RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
        await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
        _resetJwksCacheForTests();
        for (const k of Object.keys(tenantIds)) delete tenantIds[k];
        for (const k of Object.keys(assignmentIds)) delete assignmentIds[k];
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
      app.route('/api/assignments', assignmentsRouter);
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

  async function getAssignments(slug: string) {
    const res = await app.request('/api/assignments', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-test-tenant': tenantIds[slug]!,
      },
    });
    const body = (await res.json()) as ListResponse;
    return { res, body };
  }

  async function postAssignment(slug: string, title: string, dueDate: string) {
    return app.request('/api/assignments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-test-tenant': tenantIds[slug]!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, dueDate }),
    });
  }

  async function patchAssignment(slug: string, id: string, done: boolean) {
    return app.request(`/api/assignments/${id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-test-tenant': tenantIds[slug]!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ done }),
    });
  }

  Scenario('GET returns all assignments ordered by due-date', ({ Given, And, When, Then }) => {
    let res: Response;
    let body: ListResponse;

    const seedAssignment = async (_ctx: unknown, slug: string, title: string, dueDate: string) => {
      const [row] = await db
        .insert(assignments)
        .values({ tenantId: tenantIds[slug]!, title, dueDate })
        .returning();
      assignmentIds[title] = row!.id;
    };

    Given('the {string} tenant has an assignment {string} due {string}', seedAssignment);
    And('separately the {string} tenant has an assignment {string} due {string}', seedAssignment);

    When('the caller GETs /api/assignments for tenant {string}', async (_ctx, slug: string) => {
      const out = await getAssignments(slug);
      res = out.res;
      body = out.body;
    });

    Then('the GET response status is 200', () => {
      expect(res.status).toBe(200);
    });

    And('the response includes {int} assignments', (_ctx, n: number) => {
      expect(body.assignments).toHaveLength(n);
    });

    And('the first assignment is {string}', (_ctx, title: string) => {
      expect(body.assignments[0]?.title).toBe(title);
    });
  });

  Scenario('POST creates an assignment and GET returns it', ({ When, Then, And }) => {
    let postRes: Response;

    When(
      'the caller POSTs an assignment {string} due {string} in tenant {string}',
      async (_ctx, title: string, dueDate: string, slug: string) => {
        postRes = await postAssignment(slug, title, dueDate);
      },
    );

    Then('the POST response status is 201', () => {
      expect(postRes.status).toBe(201);
    });

    And(
      're-fetching /api/assignments for tenant {string} lists {int} assignments',
      async (_ctx, slug: string, n: number) => {
        const out = await getAssignments(slug);
        expect(out.res.status).toBe(200);
        expect(out.body.assignments).toHaveLength(n);
      },
    );
  });

  Scenario('PATCH toggles done flag idempotently', ({ Given, When, Then }) => {
    let body: { done: boolean };
    const togglePatch = async (done: boolean, slug: string) => {
      const res = await patchAssignment(slug, assignmentIds['Spelling']!, done);
      expect(res.status).toBe(200);
      body = (await res.json()) as { done: boolean };
    };

    Given(
      'the {string} tenant has an assignment {string} due {string}',
      async (_ctx, slug: string, title: string, dueDate: string) => {
        const [row] = await db
          .insert(assignments)
          .values({ tenantId: tenantIds[slug]!, title, dueDate })
          .returning();
        assignmentIds[title] = row!.id;
      },
    );

    When('the caller marks that assignment done in tenant {string}', async (_ctx, slug: string) => {
      await togglePatch(true, slug);
    });

    Then('the response says it is done', () => {
      expect(body.done).toBe(true);
    });

    When(
      'the caller marks that assignment not done in tenant {string}',
      async (_ctx, slug: string) => {
        await togglePatch(false, slug);
      },
    );

    Then('the response says it is not done', () => {
      expect(body.done).toBe(false);
    });
  });

  Scenario('A child member cannot create assignments', ({ Given, When, Then }) => {
    let postRes: Response;

    Given("the caller's role in {string} is {string}", async (_ctx, slug: string, role: string) => {
      await db
        .update(members)
        .set({ role: role as 'admin' | 'adult' | 'teen' | 'child' | 'guest' })
        .where(sql`tenant_id = ${tenantIds[slug]!} AND user_id = ${USER_ID}`);
    });

    When(
      'the caller POSTs an assignment {string} due {string} in tenant {string}',
      async (_ctx, title: string, dueDate: string, slug: string) => {
        postRes = await postAssignment(slug, title, dueDate);
      },
    );

    Then('the POST response status is 403', () => {
      expect(postRes.status).toBe(403);
    });
  });

  Scenario(
    "Tenant isolation — another tenant's assignments never appear",
    ({ Given, And, When, Then }) => {
      let res: Response;
      let body: ListResponse;

      const seedAssignment = async (
        _ctx: unknown,
        slug: string,
        title: string,
        dueDate: string,
      ) => {
        const [row] = await db
          .insert(assignments)
          .values({ tenantId: tenantIds[slug]!, title, dueDate })
          .returning();
        assignmentIds[title] = row!.id;
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

      And('the {string} tenant has an assignment {string} due {string}', seedAssignment);
      And('separately the {string} tenant has an assignment {string} due {string}', seedAssignment);

      When('the caller GETs /api/assignments for tenant {string}', async (_ctx, slug: string) => {
        const out = await getAssignments(slug);
        res = out.res;
        body = out.body;
      });

      Then('the GET response status is 200', () => {
        expect(res.status).toBe(200);
      });

      And('the response includes {int} assignments', (_ctx, n: number) => {
        expect(body.assignments).toHaveLength(n);
      });

      And('the first assignment is {string}', (_ctx, title: string) => {
        expect(body.assignments[0]?.title).toBe(title);
      });
    },
  );
});
