import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { journalRouter } from '../../../apps/api/src/routes/journal.js';
import { tenants, members, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

// UNIQUE kid so this steps file doesn't collide with journal-learn.steps.ts
// (which uses sarah@example.com on the same Postgres instance).
const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'journal-per-day-int-kid';
const USER_ID = '00000000-0000-4000-8000-000000000888';
const USER_EMAIL = 'zara-parent@example.com';

vi.mock('../../../apps/api/src/db/client.js', () => ({ getDb: () => getTestDb() }));

const feature = await loadFeature(new URL('../features/journal.feature', import.meta.url).pathname);

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

  // Last response from a PUT or GET call.
  let lastRes: Response;

  function headers(slug: string) {
    return { Authorization: `Bearer ${token}`, 'x-test-tenant': tenantIds[slug]! };
  }

  async function seedTenant(slug: string) {
    const [t] = await db
      .insert(tenants)
      .values({ slug, name: `${slug} Family` })
      .returning();
    tenantIds[slug] = t!.id;
    await db.insert(members).values({
      tenantId: t!.id,
      userId: USER_ID,
      displayName: 'Caller',
      role: 'admin',
    });
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

  async function putJournal(
    slug: string,
    member: string,
    entryDate: string,
    mood: string,
    body: string,
    extras: Record<string, unknown> = {},
  ) {
    return app.request('/api/journal', {
      method: 'PUT',
      headers: { ...headers(slug), 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: memberIds[member]!, entryDate, mood, body, ...extras }),
    });
  }

  async function getByDate(slug: string, member: string, date: string) {
    return app.request(`/api/journal?memberId=${memberIds[member]!}&date=${date}`, {
      headers: headers(slug),
    });
  }

  async function getEntries(slug: string, member: string) {
    return app.request(`/api/journal/entries?memberId=${memberIds[member]!}`, {
      headers: headers(slug),
    });
  }

  Background(({ Given, And }) => {
    Given('the journal test DB is clean', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE journal_entries RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
      _resetJwksCacheForTests();
      for (const m of [tenantIds, memberIds]) for (const k of Object.keys(m)) delete m[k];
    });

    And('a users mirror row exists for the journal test caller', async () => {
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
      token = await mintToken(privateKey);
    });

    And(
      'a journal tenant {string} exists with the caller as an admin member',
      async (_c, slug: string) => {
        await seedTenant(slug);
      },
    );

    And('the {string} tenant has a child {string}', async (_c, slug: string, name: string) => {
      await seedChild(slug, name);
    });
  });

  // ─── Scenario: PUT creates a new entry ──────────────────────────────────────

  Scenario('PUT creates a new entry for a day', ({ When, Then, And }) => {
    When(
      'the caller PUTs a journal entry for {string} in {string} on {string} with mood {string} and body {string}',
      async (_c, member: string, slug: string, date: string, mood: string, body: string) => {
        lastRes = await putJournal(slug, member, date, mood, body);
      },
    );
    Then('the journal PUT status is 200', () => expect(lastRes.status).toBe(200));
    And(
      'the journal entry for {string} in {string} on {string} has mood {string} and body {string}',
      async (_c, member: string, slug: string, date: string, mood: string, body: string) => {
        const res = await getByDate(slug, member, date);
        const json = (await res.json()) as { entry: { mood: string; body: string } | null };
        expect(json.entry).not.toBeNull();
        expect(json.entry?.mood).toBe(mood);
        expect(json.entry?.body).toBe(body);
      },
    );
  });

  // ─── Scenario: PUT twice updates same row ────────────────────────────────────

  Scenario('PUT same day twice updates the existing row (one row only)', ({ When, Then, And }) => {
    When(
      'the caller PUTs a journal entry for {string} in {string} on {string} with mood {string} and body {string}',
      async (_c, member: string, slug: string, date: string, mood: string, body: string) => {
        lastRes = await putJournal(slug, member, date, mood, body);
      },
    );
    And(
      'the caller PUTs a journal entry for {string} in {string} on {string} with mood {string} and body {string}',
      async (_c, member: string, slug: string, date: string, mood: string, body: string) => {
        lastRes = await putJournal(slug, member, date, mood, body);
      },
    );
    Then(
      'the journal entry for {string} in {string} on {string} has mood {string} and body {string}',
      async (_c, member: string, slug: string, date: string, mood: string, body: string) => {
        const res = await getByDate(slug, member, date);
        const json = (await res.json()) as { entry: { mood: string; body: string } | null };
        expect(json.entry?.mood).toBe(mood);
        expect(json.entry?.body).toBe(body);
      },
    );
    And(
      '{string} in {string} has exactly {int} journal entry total',
      async (_c, member: string, slug: string, count: number) => {
        const res = await getEntries(slug, member);
        const json = (await res.json()) as { entries: unknown[] };
        expect(json.entries).toHaveLength(count);
      },
    );
  });

  // ─── Scenario: round-trip all fields ────────────────────────────────────────

  Scenario(
    'GET by date round-trips mood, gratitude, body, creativity, and quoteIndex',
    ({ When, Then, And }) => {
      let getJson: { quoteIndex?: number } = {};
      When(
        'the caller PUTs a full journal entry for {string} in {string} on {string}',
        async (_c, member: string, slug: string, date: string) => {
          lastRes = await putJournal(slug, member, date, 'excited', 'Had fun', {
            gratitude1: 'sunshine',
            gratitude2: 'friends',
            gratitude3: 'food',
            creativity: { '0': 'flying', '2': 'a rocket' },
          });
        },
      );
      Then(
        'the GET by date for {string} in {string} on {string} returns all fields correctly',
        async (_c, member: string, slug: string, date: string) => {
          const res = await getByDate(slug, member, date);
          expect(res.status).toBe(200);
          const json = (await res.json()) as {
            entry: {
              mood: string;
              body: string;
              gratitude1: string;
              gratitude2: string;
              gratitude3: string;
              creativity: Record<string, string>;
            } | null;
            quoteIndex?: number;
          };
          getJson = json;
          expect(json.entry?.mood).toBe('excited');
          expect(json.entry?.body).toBe('Had fun');
          expect(json.entry?.gratitude1).toBe('sunshine');
          expect(json.entry?.gratitude2).toBe('friends');
          expect(json.entry?.gratitude3).toBe('food');
          expect(json.entry?.creativity?.['0']).toBe('flying');
          expect(json.entry?.creativity?.['2']).toBe('a rocket');
        },
      );
      And('the GET by date response includes a quoteIndex number', () => {
        // The preceding Then captured the GET (wrapper) response.
        expect(typeof getJson.quoteIndex).toBe('number');
      });
    },
  );

  // ─── Scenario: tenant isolation ─────────────────────────────────────────────

  Scenario(
    "Tenant isolation — another tenant's entries never appear",
    ({ Given, And, When, Then }) => {
      Given(
        'a second journal tenant {string} exists with the caller as an admin member',
        async (_c, slug: string) => {
          await seedTenant(slug);
        },
      );
      And('the {string} tenant has a child {string}', async (_c, slug: string, name: string) => {
        await seedChild(slug, name);
      });
      And(
        'the caller PUTs a journal entry for {string} in {string} on {string} with mood {string} and body {string}',
        async (_c, member: string, slug: string, date: string, mood: string, body: string) => {
          await putJournal(slug, member, date, mood, body);
        },
      );
      When(
        'the caller GETs journal entries for {string} in {string}',
        async (_c, member: string, slug: string) => {
          lastRes = await getEntries(slug, member);
        },
      );
      Then(
        'the journal entries list for {string} has {int} entries',
        async (_c, _member: string, count: number) => {
          const json = (await lastRes.json()) as { entries: unknown[] };
          expect(json.entries).toHaveLength(count);
        },
      );
    },
  );
});
