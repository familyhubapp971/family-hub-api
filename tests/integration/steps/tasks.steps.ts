import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { tasksRouter } from '../../../apps/api/src/routes/tasks.js';
import { tenants, members, tasks, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(new URL('../features/tasks.feature', import.meta.url).pathname);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'tasks-int-kid';
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
  tasks: Array<{ id: string; title: string; done: boolean; doneAt: string | null }>;
}

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let token: string;
  const tenantIds: Record<string, string> = {};
  const otherMemberIds: Record<string, string> = {};
  const taskIds: Record<string, string> = {};

  Background(({ Given, And }) => {
    Given('the test Postgres has clean tenants, members, tasks, and users tables', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE tasks RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
      _resetJwksCacheForTests();
      for (const k of Object.keys(tenantIds)) delete tenantIds[k];
      for (const k of Object.keys(otherMemberIds)) delete otherMemberIds[k];
      for (const k of Object.keys(taskIds)) delete taskIds[k];
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
      app.route('/api/tasks', tasksRouter);
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

  async function getTasks(slug: string) {
    const res = await app.request('/api/tasks', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'x-test-tenant': tenantIds[slug]! },
    });
    const body = (await res.json()) as ListResponse;
    return { res, body };
  }

  async function postTask(slug: string, title: string, dueDate: string) {
    return app.request('/api/tasks', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-test-tenant': tenantIds[slug]!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, dueDate }),
    });
  }

  async function patchTask(slug: string, id: string, done: boolean) {
    return app.request(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-test-tenant': tenantIds[slug]!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ done }),
    });
  }

  async function deleteTask(slug: string, id: string) {
    return app.request(`/api/tasks/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'x-test-tenant': tenantIds[slug]! },
    });
  }

  // Helper used by several scenarios — seeds a task for the caller's
  // member id (looked up by user_id).
  async function seedCallerTask(slug: string, title: string, dueDate?: string) {
    const callerRows = await db
      .select({ id: members.id })
      .from(members)
      .where(sql`tenant_id = ${tenantIds[slug]!} AND user_id = ${USER_ID}`)
      .limit(1);
    const callerMemberId = callerRows[0]!.id;
    const [row] = await db
      .insert(tasks)
      .values({
        tenantId: tenantIds[slug]!,
        memberId: callerMemberId,
        title,
        dueDate: dueDate ?? null,
      })
      .returning();
    taskIds[title] = row!.id;
  }

  async function seedOtherMemberTask(slug: string, otherName: string, title: string) {
    const [other] = await db
      .insert(members)
      .values({
        tenantId: tenantIds[slug]!,
        userId: null,
        displayName: otherName,
        role: 'adult',
      })
      .returning();
    otherMemberIds[otherName] = other!.id;
    const [row] = await db
      .insert(tasks)
      .values({ tenantId: tenantIds[slug]!, memberId: other!.id, title })
      .returning();
    taskIds[title] = row!.id;
  }

  Scenario(
    "GET returns only the caller's tasks (not other members')",
    ({ Given, And, When, Then }) => {
      let res: Response;
      let body: ListResponse;

      Given(
        'the caller has a task {string} due {string} in tenant {string}',
        async (_ctx, title: string, dueDate: string, slug: string) => {
          await seedCallerTask(slug, title, dueDate);
        },
      );

      And(
        'the {string} tenant has another adult {string} with a task {string}',
        async (_ctx, slug: string, name: string, title: string) => {
          await seedOtherMemberTask(slug, name, title);
        },
      );

      When('the caller GETs /api/tasks for tenant {string}', async (_ctx, slug: string) => {
        const out = await getTasks(slug);
        res = out.res;
        body = out.body;
      });

      Then('the GET response status is 200', () => {
        expect(res.status).toBe(200);
      });

      And('the response includes {int} tasks', (_ctx, n: number) => {
        expect(body.tasks).toHaveLength(n);
      });

      And('the first task title is {string}', (_ctx, title: string) => {
        expect(body.tasks[0]?.title).toBe(title);
      });
    },
  );

  Scenario('POST creates a task assigned to the caller; GET returns it', ({ When, Then, And }) => {
    let postRes: Response;

    When(
      'the caller POSTs a task {string} due {string} in tenant {string}',
      async (_ctx, title: string, dueDate: string, slug: string) => {
        postRes = await postTask(slug, title, dueDate);
      },
    );

    Then('the POST response status is 201', () => {
      expect(postRes.status).toBe(201);
    });

    And(
      're-fetching /api/tasks for tenant {string} lists {int} tasks',
      async (_ctx, slug: string, n: number) => {
        const out = await getTasks(slug);
        expect(out.res.status).toBe(200);
        expect(out.body.tasks).toHaveLength(n);
      },
    );
  });

  Scenario("PATCH cannot toggle another member's task", ({ Given, When, Then, And }) => {
    let patchRes: Response;

    Given(
      'the {string} tenant has another adult {string} with a task {string}',
      async (_ctx, slug: string, name: string, title: string) => {
        await seedOtherMemberTask(slug, name, title);
      },
    );

    When("the caller marks Bilal's task done in tenant {string}", async (_ctx, slug: string) => {
      patchRes = await patchTask(slug, taskIds['Renew passport']!, true);
    });

    Then('the PATCH response status is 404', () => {
      expect(patchRes.status).toBe(404);
    });

    And("Bilal's task is still not done in the database", async () => {
      const rows = await db
        .select({ doneAt: tasks.doneAt })
        .from(tasks)
        .where(sql`id = ${taskIds['Renew passport']!}`);
      expect(rows[0]?.doneAt).toBeNull();
    });
  });

  Scenario("DELETE cannot remove another member's task", ({ Given, When, Then, And }) => {
    let delRes: Response;

    Given(
      'the {string} tenant has another adult {string} with a task {string}',
      async (_ctx, slug: string, name: string, title: string) => {
        await seedOtherMemberTask(slug, name, title);
      },
    );

    When("the caller deletes Bilal's task in tenant {string}", async (_ctx, slug: string) => {
      delRes = await deleteTask(slug, taskIds['Renew passport']!);
    });

    Then('the DELETE response status is 404', () => {
      expect(delRes.status).toBe(404);
    });

    And("Bilal's task still exists in the database", async () => {
      const rows = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(sql`id = ${taskIds['Renew passport']!}`);
      expect(rows).toHaveLength(1);
    });
  });

  Scenario(
    "Tenant isolation — another tenant's tasks never appear",
    ({ Given, And, When, Then }) => {
      let res: Response;
      let body: ListResponse;

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
        'the caller has a task {string} due {string} in tenant {string}',
        async (_ctx, title: string, dueDate: string, slug: string) => {
          await seedCallerTask(slug, title, dueDate);
        },
      );

      And(
        'separately the caller has a task {string} due {string} in tenant {string}',
        async (_ctx, title: string, dueDate: string, slug: string) => {
          await seedCallerTask(slug, title, dueDate);
        },
      );

      When('the caller GETs /api/tasks for tenant {string}', async (_ctx, slug: string) => {
        const out = await getTasks(slug);
        res = out.res;
        body = out.body;
      });

      Then('the GET response status is 200', () => {
        expect(res.status).toBe(200);
      });

      And('the response includes {int} tasks', (_ctx, n: number) => {
        expect(body.tasks).toHaveLength(n);
      });

      And('the first task title is {string}', (_ctx, title: string) => {
        expect(body.tasks[0]?.title).toBe(title);
      });
    },
  );
});
