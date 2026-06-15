import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { worldFlagsRouter } from '../../../apps/api/src/routes/world-flags.js';
import { tenants, members, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({ getDb: () => getTestDb() }));

const feature = await loadFeature(
  new URL('../features/world-flags.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'world-flags-int-kid';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const USER_EMAIL = 'world-flags@example.com';

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

  async function postExplore(slug: string, member: string, countryCode: string) {
    return app.request('/api/world-flags/explore', {
      method: 'POST',
      headers: { ...headers(slug), 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: memberIds[member]!, countryCode }),
    });
  }

  async function getExplored(slug: string, member: string) {
    return app.request(`/api/world-flags?memberId=${memberIds[member]!}`, {
      method: 'GET',
      headers: headers(slug),
    });
  }

  Background(({ Given, And }) => {
    Given('the world-flags test DB is clean', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE world_flags_progress RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
      _resetJwksCacheForTests();
      for (const m of [tenantIds, memberIds]) for (const k of Object.keys(m)) delete m[k];
    });

    And('a users mirror row exists for the world-flags test caller', async () => {
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
      app.route('/api/world-flags', worldFlagsRouter);
      token = await mintToken(privateKey);
    });

    And(
      'a tenant {string} exists with the world-flags caller as admin',
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

  // ─── Scenario: Explore a flag and read it back ─────────────────────────────

  Scenario('Explore a flag and read it back', ({ When, Then, And }) => {
    let exploreRes: Response;
    let listRes: Response;
    let exploredCodes: string[] = [];

    When(
      'the caller explores country {string} for {string} in {string}',
      async (_c, code: string, member: string, slug: string) => {
        exploreRes = await postExplore(slug, member, code);
      },
    );
    Then('the explore response status is 200', () => expect(exploreRes.status).toBe(200));
    And('the explore body has explored true', async () => {
      const body = (await exploreRes.json()) as { explored: boolean };
      expect(body.explored).toBe(true);
    });
    When(
      'the caller gets explored flags for {string} in {string}',
      async (_c, member: string, slug: string) => {
        listRes = await getExplored(slug, member);
        const body = (await listRes.json()) as { explored: string[] };
        exploredCodes = body.explored ?? [];
      },
    );
    Then('the explored list contains {string}', (_c, code: string) =>
      expect(exploredCodes).toContain(code),
    );
    And('the explored list has {int} code', (_c, n: number) =>
      expect(exploredCodes).toHaveLength(n),
    );
  });

  // ─── Scenario: Idempotency ─────────────────────────────────────────────────

  Scenario('Exploring the same flag twice is idempotent — one row in DB', ({ When, Then, And }) => {
    let listRes: Response;
    let exploredCodes: string[] = [];

    When(
      'the caller explores country {string} for {string} in {string}',
      async (_c, code: string, member: string, slug: string) => {
        await postExplore(slug, member, code);
      },
    );
    And(
      'the caller explores country {string} for {string} in {string}',
      async (_c, code: string, member: string, slug: string) => {
        await postExplore(slug, member, code);
      },
    );
    When(
      'the caller gets explored flags for {string} in {string}',
      async (_c, member: string, slug: string) => {
        listRes = await getExplored(slug, member);
        const body = (await listRes.json()) as { explored: string[] };
        exploredCodes = body.explored ?? [];
      },
    );
    Then('the explored list contains {string}', (_c, code: string) =>
      expect(exploredCodes).toContain(code),
    );
    And('the explored list has {int} code', (_c, n: number) =>
      expect(exploredCodes).toHaveLength(n),
    );
  });

  // ─── Scenario: Tenant isolation ────────────────────────────────────────────

  Scenario('Tenant isolation — another member sees no explored flags', ({ When, Then }) => {
    let listRes: Response;
    let exploredCodes: string[] = [];

    When(
      'the caller explores country {string} for {string} in {string}',
      async (_c, code: string, member: string, slug: string) => {
        await postExplore(slug, member, code);
      },
    );
    When(
      'the caller gets explored flags for {string} in {string}',
      async (_c, member: string, slug: string) => {
        listRes = await getExplored(slug, member);
        const body = (await listRes.json()) as { explored: string[] };
        exploredCodes = body.explored ?? [];
      },
    );
    Then('the explored list has {int} codes', (_c, n: number) =>
      expect(exploredCodes).toHaveLength(n),
    );
  });
});
