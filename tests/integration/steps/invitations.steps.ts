import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { invitationsRouter } from '../../../apps/api/src/routes/invitations.js';
import { tenants, members, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

// Pin the config block so the route doesn't 500 on missing APP_BASE_URL
// or refuse to call the (mocked) Supabase admin.
vi.mock('../../../apps/api/src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../apps/api/src/config.js')>(
    '../../../apps/api/src/config.js',
  );
  return {
    ...actual,
    config: {
      ...actual.config,
      APP_BASE_URL: 'https://staging.familyhub.test',
      SUPABASE_URL: 'https://abc.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'svc-test-key',
    },
  };
});

// Mock the Supabase admin call so the integration tests don't hit the
// real Supabase API — we still exercise the full DB + auth path here.
const inviteUserByEmail = vi.fn();
vi.mock('../../../apps/api/src/lib/supabase-admin.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../apps/api/src/lib/supabase-admin.js')
  >('../../../apps/api/src/lib/supabase-admin.js');
  return {
    ...actual,
    inviteUserByEmail: (...args: unknown[]) => inviteUserByEmail(...args),
  };
});

const feature = await loadFeature(
  new URL('../features/invitations.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'inv-int-kid';
const USER_ID = '00000000-0000-4000-8000-000000000999';
const USER_EMAIL = 'inviter-int@example.com';

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

// Stub resolveTenant — reads the tenant id from an X-Test-Tenant header
// so each scenario can target a specific tenant without having to wire
// the real subdomain/path resolution chain.
const resolveTenantFromHeader: MiddlewareHandler = async (c, next) => {
  const tenantId = c.req.header('x-test-tenant');
  c.set('tenantId', tenantId);
  await next();
};

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let token: string;
  const tenantIds: Record<string, string> = {};

  Background(({ Given, And }) => {
    Given(
      'the test Postgres has clean tenants, members, and pending_invitations tables',
      async () => {
        db = getTestDb() as unknown as Database;
        await db.execute(sql`TRUNCATE TABLE pending_invitations RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
        _resetJwksCacheForTests();
        inviteUserByEmail.mockReset();
        // Default mock — return a stable Supabase user id.
        inviteUserByEmail.mockResolvedValue({ id: 'supabase-user-int-uuid' });
        // Reset the tenant-id cache between scenarios.
        for (const k of Object.keys(tenantIds)) delete tenantIds[k];
      },
    );

    And('a users mirror row exists for the test inviter', async () => {
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
      app.route('/api/invitations', invitationsRouter);
      token = await mintToken(privateKey);
    });

    And(
      'a tenant {string} exists with the inviter as an admin member',
      async (_ctx, slug: string) => {
        const insertedTenants = await db
          .insert(tenants)
          .values({ slug, name: `${slug} Family` })
          .returning();
        const tenant = insertedTenants[0]!;
        tenantIds[slug] = tenant.id;
        await db.insert(members).values({
          tenantId: tenant.id,
          userId: USER_ID,
          displayName: 'Inviter',
          role: 'admin',
        });
      },
    );
  });

  Scenario(
    'Happy path — admin invites a new email, row stored as pending',
    ({ When, Then, And }) => {
      let res: Response;

      When(
        'the inviter POSTs an invitation for {string} as {string}',
        async (_ctx, email: string, role: string) => {
          res = await app.request('/api/invitations', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'x-test-tenant': tenantIds['khan']!,
            },
            body: JSON.stringify({ email, role }),
          });
        },
      );

      Then('the response status is 201', () => {
        expect(res.status).toBe(201);
      });

      And(
        'exactly 1 row exists in pending_invitations with email {string} and status {string}',
        async (_ctx, email: string, status: string) => {
          const { rows } = await db.execute<{ count: string }>(
            sql`SELECT COUNT(*)::text AS count FROM pending_invitations
              WHERE email = ${email} AND status = ${status}`,
          );
          expect(Number(rows[0]?.count)).toBe(1);
        },
      );

      And(
        'Supabase admin invite was called once with redirect_to containing {string}',
        (_ctx, substr: string) => {
          expect(inviteUserByEmail).toHaveBeenCalledTimes(1);
          const arg = inviteUserByEmail.mock.calls[0]![0] as { redirectTo: string };
          expect(arg.redirectTo).toContain(substr);
        },
      );
    },
  );

  Scenario(
    'Same tenant cannot double-invite the same email while one is pending',
    ({ Given, When, Then, And }) => {
      let res: Response;

      Given(
        'the inviter has an outstanding pending invite for {string}',
        async (_ctx, email: string) => {
          // Seed via the API so the row goes through exactly the same
          // path as a real first invite.
          await app.request('/api/invitations', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'x-test-tenant': tenantIds['khan']!,
            },
            body: JSON.stringify({ email, role: 'adult' }),
          });
        },
      );

      When(
        'the inviter POSTs an invitation for {string} as {string}',
        async (_ctx, email: string, role: string) => {
          res = await app.request('/api/invitations', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'x-test-tenant': tenantIds['khan']!,
            },
            body: JSON.stringify({ email, role }),
          });
        },
      );

      Then('the response status is 409', () => {
        expect(res.status).toBe(409);
      });

      And(
        'exactly 1 row exists in pending_invitations with email {string} and status {string}',
        async (_ctx, email: string, status: string) => {
          const { rows } = await db.execute<{ count: string }>(
            sql`SELECT COUNT(*)::text AS count FROM pending_invitations
                WHERE email = ${email} AND status = ${status}`,
          );
          expect(Number(rows[0]?.count)).toBe(1);
        },
      );
    },
  );

  Scenario('A different tenant CAN invite the same email', ({ Given, When, Then, And }) => {
    let res: Response;

    Given(
      'a second tenant {string} exists with the inviter as an admin member',
      async (_ctx, slug: string) => {
        const insertedTenants = await db
          .insert(tenants)
          .values({ slug, name: `${slug} Family` })
          .returning();
        const tenant = insertedTenants[0]!;
        tenantIds[slug] = tenant.id;
        await db.insert(members).values({
          tenantId: tenant.id,
          userId: USER_ID,
          displayName: 'Inviter',
          role: 'admin',
        });
      },
    );

    // The .feature uses `And` for the second precondition — bind via
    // `And()` not `Given()` so @amiceli/vitest-cucumber matches the
    // keyword exactly (the library is strict about Given vs And).
    And(
      'the inviter has an outstanding pending invite for {string} in tenant {string}',
      async (_ctx, email: string, slug: string) => {
        await app.request('/api/invitations', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'x-test-tenant': tenantIds[slug]!,
          },
          body: JSON.stringify({ email, role: 'adult' }),
        });
      },
    );

    When(
      'the inviter POSTs an invitation for {string} as {string} in tenant {string}',
      async (_ctx, email: string, role: string, slug: string) => {
        res = await app.request('/api/invitations', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'x-test-tenant': tenantIds[slug]!,
          },
          body: JSON.stringify({ email, role }),
        });
      },
    );

    Then('the response status is 201', () => {
      expect(res.status).toBe(201);
    });

    And(
      'exactly 2 rows exist in pending_invitations with email {string} and status {string}',
      async (_ctx, email: string, status: string) => {
        const { rows } = await db.execute<{ count: string }>(
          sql`SELECT COUNT(*)::text AS count FROM pending_invitations
              WHERE email = ${email} AND status = ${status}`,
        );
        expect(Number(rows[0]?.count)).toBe(2);
      },
    );
  });
});
