import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { publicTenantRouter } from '../../../apps/api/src/routes/public-tenant.js';
import { tenants, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

// Stub getDb so the route uses the SAME pool as our Background steps —
// tests/integration/support/db.ts is the canonical test pool.
vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(
  new URL('../features/public-tenant.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'pt-int-kid';
const USER_ID = '00000000-0000-4000-8000-000000000888';
const USER_EMAIL = 'sarah-int@example.com';

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

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let token: string;

  Background(({ Given, And }) => {
    Given('the test Postgres has clean tenants and members tables', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      _resetJwksCacheForTests();
    });

    And('a users mirror row exists for the test user', async () => {
      // Insert (or upsert) the public.users mirror row directly so the
      // route's userRow context resolves to this user.
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
          // Mirror sync returns the row we just inserted — same id.
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
      app.route('/api/public/tenant', publicTenantRouter);
      token = await mintToken(privateKey);
    });
  });

  Scenario('Happy path — creates tenant and member, returns 201', ({ When, Then, And }) => {
    let res: Response;
    let body: { tenant?: { slug: string } };

    When(
      'I POST to /api/public/tenant with familyName "Khan" displayName "Sarah" slug "khan"',
      async () => {
        res = await app.request('/api/public/tenant', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ familyName: 'Khan', displayName: 'Sarah', slug: 'khan' }),
        });
        body = (await res.json()) as { tenant?: { slug: string } };
      },
    );

    Then('the response status is 201', () => {
      expect(res.status).toBe(201);
    });

    And('the response body has a tenant with slug "khan"', () => {
      expect(body.tenant?.slug).toBe('khan');
    });

    And('exactly 1 row exists in tenants with slug "khan"', async () => {
      const { rows } = await db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count FROM tenants WHERE slug = ${'khan'}`,
      );
      expect(Number(rows[0]?.count)).toBe(1);
    });

    And('exactly 1 row exists in members with displayName "Sarah" and role "adult"', async () => {
      const { rows } = await db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count FROM members WHERE display_name = ${'Sarah'} AND role = 'adult'`,
      );
      expect(Number(rows[0]?.count)).toBe(1);
    });
  });

  Scenario('Slug already taken — returns 409 and inserts nothing', ({ Given, When, Then, And }) => {
    let res: Response;

    Given('a tenant exists with slug "khan"', async () => {
      await db.insert(tenants).values({ slug: 'khan', name: 'Pre-existing Khan' });
    });

    When(
      'I POST to /api/public/tenant with familyName "Khan" displayName "Sarah" slug "khan"',
      async () => {
        res = await app.request('/api/public/tenant', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ familyName: 'Khan', displayName: 'Sarah', slug: 'khan' }),
        });
      },
    );

    Then('the response status is 409', () => {
      expect(res.status).toBe(409);
    });

    And('exactly 1 row exists in tenants with slug "khan"', async () => {
      const { rows } = await db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count FROM tenants WHERE slug = ${'khan'}`,
      );
      expect(Number(rows[0]?.count)).toBe(1);
    });
  });
});
