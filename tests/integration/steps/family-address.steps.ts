import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../src/security/auth.js';
import { familyAddressRouter } from '../../../src/areas/family/family-address.js';
import { publicKidMembersRouter } from '../../../src/areas/family/public-kid-members.js';
import { members, tenants, users } from '../../../src/database/schema.js';
import type { Database } from '../../../src/database/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../src/database/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(
  new URL('../features/family-address.feature', import.meta.url).pathname,
);

const ISSUER = 'https://auth.test.local/auth/v1';
const KID = 'fa-int-kid';
const USER_ID = '00000000-0000-4000-8000-000000000715';
const USER_EMAIL = 'family-address-int@example.com';

async function genKey() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  Object.assign(publicJwk, { alg: 'ES256', kid: KID, use: 'sig' });
  return { privateKey, publicJwk };
}

function mintToken(privateKey: KeyLike) {
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
    return (await importJWK(publicJwk, header.alg ?? 'ES256')) as KeyLike;
  };
}

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let token: string;
  let tenantId: string;
  let res: Response;

  Background(({ Given, And }) => {
    Given(
      'the test Postgres has a family with code "e29b-41d4" that used to be "smith"',
      async () => {
        db = getTestDb() as unknown as Database;
        await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
        _resetJwksCacheForTests();
        const rows = await db
          .insert(tenants)
          .values({ slug: 'e29b-41d4', previousSlug: 'smith', name: 'The Smith Family' })
          .returning();
        tenantId = rows[0]!.id;
        // A kid with a PIN, so the faces list would have someone to show.
        await db.insert(members).values({
          tenantId,
          displayName: 'Aisha',
          role: 'child',
          isChild: true,
          pinHash: 'not-a-real-hash',
        });
      },
    );
    And('a users mirror row exists for the test user', async () => {
      await db.execute(
        sql`INSERT INTO users (id, email) VALUES (${USER_ID}, ${USER_EMAIL})
            ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      );
      const { privateKey, publicJwk } = await genKey();
      app = new Hono();
      app.route('/api/public/kid-members', publicKidMembersRouter);
      app.use(
        '/api/family-address/*',
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
      app.route('/api/family-address', familyAddressRouter);
      token = await mintToken(privateKey);
    });
  });

  Scenario("A family's own member is sent to the new address", ({ Given, When, Then, And }) => {
    let body: { slug?: string };
    Given('the test user is a member of that family', async () => {
      await db
        .insert(members)
        .values({ tenantId, userId: USER_ID, displayName: 'Sam', role: 'admin' });
    });
    When('the test user asks where "smith" moved', async () => {
      res = await app.request('/api/family-address/smith', {
        headers: { Authorization: `Bearer ${token}` },
      });
      body = (await res.json()) as { slug?: string };
    });
    Then('the answer status is 200', () => {
      expect(res.status).toBe(200);
    });
    And('the new address is "e29b-41d4"', () => {
      expect(body.slug).toBe('e29b-41d4');
    });
  });

  Scenario('Someone outside the family learns nothing', ({ When, Then }) => {
    When('the test user asks where "smith" moved', async () => {
      res = await app.request('/api/family-address/smith', {
        headers: { Authorization: `Bearer ${token}` },
      });
    });
    Then('the answer status is 404', () => {
      expect(res.status).toBe(404);
    });
  });

  Scenario("The kids' faces never show for an old surname", ({ When, Then }) => {
    When('anyone asks for the kids of "smith"', async () => {
      res = await app.request('/api/public/kid-members/smith');
    });
    Then('the answer status is 404', () => {
      expect(res.status).toBe(404);
    });
  });
});
