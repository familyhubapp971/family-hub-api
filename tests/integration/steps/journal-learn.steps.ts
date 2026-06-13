import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { journalRouter } from '../../../apps/api/src/routes/journal.js';
import { learnRouter } from '../../../apps/api/src/routes/learn.js';
import { tenants, members, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({ getDb: () => getTestDb() }));

const feature = await loadFeature(
  new URL('../features/journal-learn.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'journal-learn-int-kid';
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
  c.set('tenantId', c.req.header('x-test-tenant'));
  await next();
};

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let token: string;
  const tenantIds: Record<string, string> = {};
  const memberIds: Record<string, string> = {};

  function headers(slug: string) {
    return { Authorization: `Bearer ${token}`, 'x-test-tenant': tenantIds[slug]! };
  }

  async function seedTenant(slug: string) {
    const [t] = await db
      .insert(tenants)
      .values({ slug, name: `${slug} Family` })
      .returning();
    tenantIds[slug] = t!.id;
    await db
      .insert(members)
      .values({ tenantId: t!.id, userId: USER_ID, displayName: 'Caller', role: 'admin' });
  }
  async function seedChild(slug: string, name: string) {
    const [r] = await db
      .insert(members)
      .values({
        tenantId: tenantIds[slug]!,
        userId: null,
        displayName: name,
        role: 'child',
        isChild: true,
      })
      .returning();
    memberIds[name] = r!.id;
  }

  async function postJournal(slug: string, member: string, body: string) {
    return app.request('/api/journal', {
      method: 'POST',
      headers: { ...headers(slug), 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: memberIds[member]!, body }),
    });
  }
  async function getJournal(slug: string, member: string) {
    const res = await app.request(`/api/journal?memberId=${memberIds[member]!}`, {
      method: 'GET',
      headers: headers(slug),
    });
    const json = (await res.json()) as { entries: unknown[] };
    return { res, entries: json.entries ?? [] };
  }
  async function getLearn(slug: string, member: string) {
    const res = await app.request(`/api/learn?memberId=${memberIds[member]!}`, {
      method: 'GET',
      headers: headers(slug),
    });
    const json = (await res.json()) as { subjects: Array<{ subject: string; progress: number }> };
    return { res, subjects: json.subjects ?? [] };
  }
  async function patchLearn(slug: string, member: string, subject: string, progress: number) {
    return app.request(`/api/learn/${encodeURIComponent(subject)}`, {
      method: 'PATCH',
      headers: { ...headers(slug), 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: memberIds[member]!, progress }),
    });
  }

  Background(({ Given, And }) => {
    Given('the test Postgres has clean tenants, members, journal, and learn tables', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE journal_entries RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE learn_progress RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
      _resetJwksCacheForTests();
      for (const m of [tenantIds, memberIds]) for (const k of Object.keys(m)) delete m[k];
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
      app.route('/api/journal', journalRouter);
      app.route('/api/learn', learnRouter);
      token = await mintToken(privateKey);
    });
    And('a tenant {string} exists with the caller as an admin member', async (_c, slug: string) => {
      await seedTenant(slug);
    });
    And(
      'the {string} tenant has children {string} and {string}',
      async (_c, slug: string, a: string, b: string) => {
        await seedChild(slug, a);
        await seedChild(slug, b);
      },
    );
  });

  Scenario('Posting a journal entry and reading it back', ({ When, Then, And }) => {
    let res: Response;
    When(
      'the caller posts a journal entry {string} for {string} in tenant {string}',
      async (_c, body: string, member: string, slug: string) => {
        res = await postJournal(slug, member, body);
      },
    );
    Then('the journal post status is 201', () => expect(res.status).toBe(201));
    And(
      'in tenant {string}, {string} has {int} journal entries and {string} has {int}',
      async (_c, slug: string, memberA: string, nA: number, memberB: string, nB: number) => {
        const a = await getJournal(slug, memberA);
        const b = await getJournal(slug, memberB);
        expect(a.entries).toHaveLength(nA);
        expect(b.entries).toHaveLength(nB);
      },
    );
  });

  Scenario(
    'Learn GET returns the full subject catalogue defaulting to zero',
    ({ When, Then, And }) => {
      let res: Response;
      let subjects: Array<{ subject: string; progress: number }>;
      When(
        'the caller GETs learn progress for {string} in tenant {string}',
        async (_c, member: string, slug: string) => {
          const out = await getLearn(slug, member);
          res = out.res;
          subjects = out.subjects;
        },
      );
      Then('the learn response status is 200', () => expect(res.status).toBe(200));
      And('the learn response has {int} subjects', (_c, n: number) =>
        expect(subjects).toHaveLength(n),
      );
      And(
        'the {string} subject for {string} reads {int}',
        (_c, subject: string, _m: string, val: number) => {
          expect(subjects.find((s) => s.subject === subject)?.progress).toBe(val);
        },
      );
    },
  );

  Scenario('PATCH learn progress upserts and GET reflects it', ({ When, Then, And }) => {
    let res: Response;
    When(
      'the caller sets {string} progress to {int} for {string} in tenant {string}',
      async (_c, subject: string, progress: number, member: string, slug: string) => {
        res = await patchLearn(slug, member, subject, progress);
      },
    );
    Then('the learn patch status is 200', () => expect(res.status).toBe(200));
    And(
      'the {string} subject for {string} reads {int}',
      async (_c, subject: string, member: string, val: number) => {
        const out = await getLearn('khan', member);
        expect(out.subjects.find((s) => s.subject === subject)?.progress).toBe(val);
      },
    );
  });

  Scenario('PATCH an unknown subject is rejected', ({ When, Then }) => {
    let res: Response;
    When(
      'the caller sets {string} progress to {int} for {string} in tenant {string}',
      async (_c, subject: string, progress: number, member: string, slug: string) => {
        res = await patchLearn(slug, member, subject, progress);
      },
    );
    Then('the learn patch status is 400', () => expect(res.status).toBe(400));
  });

  Scenario(
    "Tenant isolation — another tenant's journal never appears",
    ({ Given, And, When, Then }) => {
      let res: Response;
      let entries: unknown[];
      Given(
        'a second tenant {string} exists with the caller as an admin member',
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
        'the caller posts a journal entry {string} for {string} in tenant {string}',
        async (_c, body: string, member: string, slug: string) => {
          await postJournal(slug, member, body);
        },
      );
      When(
        'the caller GETs journal for {string} in tenant {string}',
        async (_c, member: string, slug: string) => {
          const out = await getJournal(slug, member);
          res = out.res;
          entries = out.entries;
        },
      );
      Then('the journal response status is 200', () => expect(res.status).toBe(200));
      And('the journal response has {int} entries', (_c, n: number) =>
        expect(entries).toHaveLength(n),
      );
    },
  );
});
