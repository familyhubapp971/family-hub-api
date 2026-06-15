import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { readingLogRouter } from '../../../apps/api/src/routes/reading-log.js';
import { tenants, members, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({ getDb: () => getTestDb() }));

const feature = await loadFeature(
  new URL('../features/reading-log.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'reading-log-int-kid';
const USER_ID = '00000000-0000-4000-8000-000000000888';
const USER_EMAIL = 'reading-log@example.com';

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
  // Track created book ids by title so steps can reference them.
  const bookIds: Record<string, string> = {};

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

  async function addBook(slug: string, member: string, title: string, author: string) {
    return app.request('/api/reading-log', {
      method: 'POST',
      headers: { ...headers(slug), 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: memberIds[member]!, title, author }),
    });
  }
  async function listBooks(slug: string, member: string) {
    return app.request(`/api/reading-log?memberId=${memberIds[member]!}`, {
      method: 'GET',
      headers: headers(slug),
    });
  }
  async function patchBook(slug: string, bookId: string, member: string, finished: boolean) {
    return app.request(`/api/reading-log/${bookId}`, {
      method: 'PATCH',
      headers: { ...headers(slug), 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: memberIds[member]!, finished }),
    });
  }
  async function deleteBook(slug: string, bookId: string, member: string) {
    return app.request(`/api/reading-log/${bookId}?memberId=${memberIds[member]!}`, {
      method: 'DELETE',
      headers: headers(slug),
    });
  }

  Background(({ Given, And }) => {
    Given('the reading-log test DB is clean', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE reading_log RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
      _resetJwksCacheForTests();
      for (const m of [tenantIds, memberIds, bookIds]) for (const k of Object.keys(m)) delete m[k];
    });
    And('a users mirror row exists for the reading-log test caller', async () => {
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
      app.route('/api/reading-log', readingLogRouter);
      token = await mintToken(privateKey);
    });
    And(
      'a tenant {string} exists with the reading-log caller as admin',
      async (_c, slug: string) => {
        await seedTenant(slug);
      },
    );
    And('the {string} tenant has a child {string}', async (_c, slug: string, name: string) => {
      await seedChild(slug, name);
    });
    And(
      'a second child {string} also exists in {string}',
      async (_c, name: string, slug: string) => {
        await seedChild(slug, name);
      },
    );
  });

  // ─── Scenario: Add a book and read it back ────────────────────────────────

  Scenario('Add a book and read it back', ({ When, Then, And }) => {
    let addRes: Response;
    let listRes: Response;
    let books: Array<{ id: string; title: string; author: string | null; finished: boolean }>;

    When(
      'the caller adds a book {string} by {string} for {string} in {string}',
      async (_c, title: string, author: string, member: string, slug: string) => {
        addRes = await addBook(slug, member, title, author);
        if (addRes.status === 201) {
          const body = (await addRes.json()) as { id: string; title: string };
          bookIds[body.title] = body.id;
        }
      },
    );
    Then('the add-book response status is 201', () => expect(addRes.status).toBe(201));
    And('the response book title is {string}', async (_c, title: string) => {
      // already consumed above — clone not possible; check bookIds was populated
      expect(bookIds[title]).toBeTruthy();
    });
    When(
      'the caller lists books for {string} in {string}',
      async (_c, member: string, slug: string) => {
        listRes = await listBooks(slug, member);
        const json = (await listRes.json()) as { books: typeof books };
        books = json.books ?? [];
      },
    );
    Then('the list response has {int} book', (_c, n: number) => expect(books).toHaveLength(n));
    And('book {int} title is {string}', (_c, idx: number, title: string) =>
      expect(books[idx]?.title).toBe(title),
    );
    And('book {int} finished is {word}', (_c, idx: number, val: string) =>
      expect(books[idx]?.finished).toBe(val === 'true'),
    );
  });

  // ─── Scenario: Mark a book as finished ───────────────────────────────────

  Scenario('Mark a book as finished', ({ Given, When, Then, And }) => {
    let patchRes: Response;
    let listRes: Response;
    let books: Array<{ id: string; title: string; finished: boolean }>;

    Given(
      'the caller adds a book {string} by {string} for {string} in {string}',
      async (_c, title: string, author: string, member: string, slug: string) => {
        const res = await addBook(slug, member, title, author);
        const body = (await res.json()) as { id: string; title: string };
        bookIds[body.title] = body.id;
      },
    );
    When(
      'the caller marks book {string} as finished for {string} in {string}',
      async (_c, title: string, member: string, slug: string) => {
        patchRes = await patchBook(slug, bookIds[title]!, member, true);
      },
    );
    Then('the patch-book response status is 200', () => expect(patchRes.status).toBe(200));
    And('the patched book finished is true', async () => {
      const body = (await patchRes.json()) as { finished: boolean };
      expect(body.finished).toBe(true);
    });
    When(
      'the caller lists books for {string} in {string}',
      async (_c, member: string, slug: string) => {
        listRes = await listBooks(slug, member);
        const json = (await listRes.json()) as { books: typeof books };
        books = json.books ?? [];
      },
    );
    Then('book {int} finished is {word}', (_c, idx: number, val: string) =>
      expect(books[idx]?.finished).toBe(val === 'true'),
    );
  });

  // ─── Scenario: Delete a book ──────────────────────────────────────────────

  Scenario('Delete a book', ({ Given, When, Then }) => {
    let deleteRes: Response;
    let listRes: Response;
    let books: Array<{ id: string; title: string }>;

    Given(
      'the caller adds a book {string} by {string} for {string} in {string}',
      async (_c, title: string, author: string, member: string, slug: string) => {
        const res = await addBook(slug, member, title, author);
        const body = (await res.json()) as { id: string; title: string };
        bookIds[body.title] = body.id;
      },
    );
    When(
      'the caller deletes book {string} for {string} in {string}',
      async (_c, title: string, member: string, slug: string) => {
        deleteRes = await deleteBook(slug, bookIds[title]!, member);
      },
    );
    Then('the delete response status is 204', () => expect(deleteRes.status).toBe(204));
    When(
      'the caller lists books for {string} in {string}',
      async (_c, member: string, slug: string) => {
        listRes = await listBooks(slug, member);
        const json = (await listRes.json()) as { books: typeof books };
        books = json.books ?? [];
      },
    );
    Then('the list response has {int} books', (_c, n: number) => expect(books).toHaveLength(n));
  });

  // ─── Scenario: Tenant isolation — another member sees no books ────────────

  Scenario('Tenant isolation — another member sees no books', ({ Given, When, Then }) => {
    let listRes: Response;
    let books: Array<{ id: string; title: string }>;

    Given(
      'the caller adds a book {string} by {string} for {string} in {string}',
      async (_c, title: string, author: string, member: string, slug: string) => {
        const res = await addBook(slug, member, title, author);
        const body = (await res.json()) as { id: string; title: string };
        bookIds[body.title] = body.id;
      },
    );
    When(
      'the caller lists books for {string} in {string}',
      async (_c, member: string, slug: string) => {
        listRes = await listBooks(slug, member);
        const json = (await listRes.json()) as { books: typeof books };
        books = json.books ?? [];
      },
    );
    Then('the list response has {int} books', (_c, n: number) => expect(books).toHaveLength(n));
  });
});
