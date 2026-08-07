/**
 * Step bindings for admin-family-name.feature (FHS-626).
 *
 * The Family settings screen offers a family name. Before this there was no
 * way to save one: the settings endpoint only ever special-cased the currency,
 * so a name would have looked editable and quietly done nothing.
 *
 * These scenarios prove the three things that matter: an admin can rename,
 * nobody else can, and the family's web address (its slug) never moves, so a
 * saved link keeps working.
 */

import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { adminRouter } from '../../../apps/api/src/routes/admin.js';
import { tenants, members, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({ getDb: () => getTestDb() }));

const feature = await loadFeature(
  new URL('../features/admin-family-name.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'admin-family-name-kid';
const ADMIN_ID = '00000000-0000-4000-8000-000000000626';
const ADMIN_EMAIL = 'familyname-admin@example.com';
const ADULT_ID = '00000000-0000-4000-8000-000000006262';
const ADULT_EMAIL = 'familyname-adult@example.com';

async function genKey() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = 'ES256';
  publicJwk.kid = KID;
  publicJwk.use = 'sig';
  return { privateKey, publicJwk };
}

async function mintToken(privateKey: KeyLike, userId: string, email: string) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setSubject(userId)
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
  let adminToken: string;
  let adultToken: string;
  let tenantId: string;
  let lastStatus = 0;

  function headers(token: string) {
    return {
      Authorization: `Bearer ${token}`,
      'x-test-tenant': tenantId,
      'Content-Type': 'application/json',
    };
  }

  async function setFamilyName(token: string, value: string) {
    const res = await app.request('/api/admin/settings/familyName', {
      method: 'PUT',
      headers: headers(token),
      body: JSON.stringify({ value }),
    });
    lastStatus = res.status;
  }

  async function readFamilyName(): Promise<string> {
    const res = await app.request('/api/admin/settings', { headers: headers(adminToken) });
    const body = (await res.json()) as Record<string, string>;
    return body['familyName'] ?? '';
  }

  Background(({ Given, And }) => {
    Given('the test Postgres has clean admin tables', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE app_settings RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${ADMIN_ID}, ${ADULT_ID})`);
      _resetJwksCacheForTests();
    });

    And('a users mirror row exists for the admin caller', async () => {
      for (const [id, email] of [
        [ADMIN_ID, ADMIN_EMAIL],
        [ADULT_ID, ADULT_EMAIL],
      ]) {
        await db.execute(
          sql`INSERT INTO users (id, email) VALUES (${id}, ${email})
              ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
        );
      }
      const { privateKey, publicJwk } = await genKey();
      app = new Hono();
      app.use(
        '*',
        authMiddleware({
          issuer: ISSUER,
          jwks: makeJwks(publicJwk),
          userMirrorSync: async (claims) => {
            const rows = await db
              .select()
              .from(users)
              .where(sql`id = ${claims.id}`)
              .limit(1);
            return rows[0]!;
          },
        }),
      );
      app.use('*', resolveTenantFromHeader);
      app.route('/api/admin', adminRouter);
      adminToken = await mintToken(privateKey, ADMIN_ID, ADMIN_EMAIL);
      adultToken = await mintToken(privateKey, ADULT_ID, ADULT_EMAIL);
    });

    And(
      'a tenant {string} exists named {string} with the caller as an admin member',
      async (_c, slug: string, name: string) => {
        const [tenant] = await db.insert(tenants).values({ slug, name }).returning();
        tenantId = tenant!.id;
        await db
          .insert(members)
          .values({ tenantId, userId: ADMIN_ID, displayName: 'Admin', role: 'admin' });
      },
    );
  });

  Scenario('an admin renames the family', ({ When, Then, And }) => {
    When('the admin sets the family name to {string}', async (_c, value: string) => {
      await setFamilyName(adminToken, value);
    });
    Then('the rename is accepted', () => {
      expect(lastStatus).toBe(200);
    });
    And('reading the settings back shows the family name {string}', async (_c, name: string) => {
      expect(await readFamilyName()).toBe(name);
    });
  });

  Scenario("the family's web address does not move", ({ When, Then, And }) => {
    When('the admin sets the family name to {string}', async (_c, value: string) => {
      await setFamilyName(adminToken, value);
    });
    Then('the rename is accepted', () => {
      expect(lastStatus).toBe(200);
    });
    And('the family is still found at the slug {string}', async (_c, slug: string) => {
      const rows = await db
        .select({ slug: tenants.slug })
        .from(tenants)
        .where(sql`id = ${tenantId}`);
      expect(rows[0]?.slug).toBe(slug);
    });
  });

  Scenario('a blank name is refused', ({ When, Then, And }) => {
    When('the admin sets the family name to {string}', async (_c, value: string) => {
      await setFamilyName(adminToken, value);
    });
    Then('the rename is refused as invalid', () => {
      expect(lastStatus).toBe(400);
    });
    And('reading the settings back shows the family name {string}', async (_c, name: string) => {
      expect(await readFamilyName()).toBe(name);
    });
  });

  Scenario('a non-admin cannot rename the family', ({ Given, When, Then, And }) => {
    Given('the {string} tenant has an adult member who is not an admin', async () => {
      await db
        .insert(members)
        .values({ tenantId, userId: ADULT_ID, displayName: 'Adult', role: 'adult' });
    });
    When('that adult sets the family name to {string}', async (_c, value: string) => {
      await setFamilyName(adultToken, value);
    });
    Then('the rename is refused as forbidden', () => {
      expect(lastStatus).toBe(403);
    });
    And('reading the settings back shows the family name {string}', async (_c, name: string) => {
      expect(await readFamilyName()).toBe(name);
    });
  });
});
