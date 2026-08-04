/**
 * Step bindings for admin-gdpr.feature (FHS-435).
 *
 * Covers GET /api/admin/export and POST /api/admin/delete-account against
 * real Postgres. Both endpoints are admin-only and tenant-scoped; delete is
 * IRREVERSIBLE, so these scenarios prove:
 *   - export never contains another tenant's rows,
 *   - a wrong confirmation deletes nothing,
 *   - a correct confirmation removes the tenant + every row across ALL
 *     TENANT_SCOPED_TABLES (via the tenants → * ON DELETE CASCADE FK graph),
 *   - a sibling tenant's data is completely untouched either way.
 *
 * Every `.feature` line is bound via the SAME keyword it uses in the file
 * (Given/When/Then/And): @amiceli/vitest-cucumber matches on the literal
 * keyword, not just the step text (see admin-panel.steps.ts / invitations
 * .steps.ts for the same note).
 */

import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { adminRouter } from '../../../apps/api/src/routes/admin.js';
import { TENANT_SCOPED_TABLES, tenants, members, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';
import { seedAllTablesForTenant } from '../support/seed-tenant-tables.js';

// The admin router calls getDb() directly (not through the request-scoped
// AsyncLocalStorage plumbing): mock it to the real test Postgres pool, same
// as admin-panel.steps.ts, so every request in this file hits :5433.
vi.mock('../../../apps/api/src/db/client.js', () => ({ getDb: () => getTestDb() }));

const feature = await loadFeature(
  new URL('../features/admin-gdpr.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'admin-gdpr-int-kid';
const USER_ID = '00000000-0000-4000-8000-000000000435';
const USER_EMAIL = 'admingdpr@example.com';
const GUEST_USER_ID = '00000000-0000-4000-8000-000000004352';
const GUEST_USER_EMAIL = 'guestgdpr@example.com';

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
  let token: string;
  let guestToken: string;
  const tenantIds: Record<string, string> = {};

  let lastExport: { status: number; headers: Headers; body: Record<string, unknown> };
  let lastDelete: { status: number; body: Record<string, unknown> };
  // Actual per-table row counts right after seeding, keyed by slug then table
  // name. `members` legitimately has 2 rows per tenant (the seeded admin
  // "Caller" + the seedAllTablesForTenant fixture row): snapshotting the
  // real count instead of assuming "1 row everywhere" keeps every assertion
  // below correct without hardcoding that exception per table.
  const baselineCounts: Record<string, Record<string, number>> = {};

  function headers(slug: string, forUserId = USER_ID) {
    const t = forUserId === GUEST_USER_ID ? guestToken : token;
    return {
      Authorization: `Bearer ${t}`,
      'x-test-tenant': tenantIds[slug]!,
      'Content-Type': 'application/json',
    };
  }

  async function seedTenant(slug: string) {
    const [tenant] = await db
      .insert(tenants)
      .values({ slug, name: `${slug} Family` })
      .returning();
    tenantIds[slug] = tenant!.id;
    await db
      .insert(members)
      .values({ tenantId: tenant!.id, userId: USER_ID, displayName: 'Caller', role: 'admin' });
  }

  async function seedGuest(slug: string, name: string) {
    await db.insert(members).values({
      tenantId: tenantIds[slug]!,
      userId: GUEST_USER_ID,
      displayName: name,
      role: 'guest',
    });
  }

  /** COUNT(*) FROM "<table>" WHERE tenant_id = <tenantId>. */
  async function tenantRowCount(tableName: string, tenantId: string): Promise<number> {
    const { rows } = await db.execute<{ count: string }>(
      sql.raw(`SELECT COUNT(*)::text AS count FROM "${tableName}" WHERE tenant_id = '${tenantId}'`),
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function tenantExists(tenantId: string): Promise<boolean> {
    const { rows } = await db.execute<{ id: string }>(
      sql.raw(`SELECT id FROM tenants WHERE id = '${tenantId}'`),
    );
    return rows.length > 0;
  }

  /** Snapshot the real per-table row count for `slug` right after seeding. */
  async function snapshotCounts(slug: string): Promise<void> {
    const tenantId = tenantIds[slug]!;
    const counts: Record<string, number> = {};
    for (const table of TENANT_SCOPED_TABLES) {
      const name = getTableConfig(table).name;
      counts[name] = await tenantRowCount(name, tenantId);
    }
    baselineCounts[slug] = counts;
  }

  // ─── Background ───────────────────────────────────────────────────────────

  Background(({ Given, And }) => {
    Given('the test Postgres has clean admin-gdpr tables', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${USER_ID}, ${GUEST_USER_ID})`);
      _resetJwksCacheForTests();
      for (const k of Object.keys(tenantIds)) delete tenantIds[k];
    });

    And('a users mirror row exists for the admin-gdpr test caller', async () => {
      await db.execute(
        sql`INSERT INTO users (id, email) VALUES (${USER_ID}, ${USER_EMAIL})
            ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      );
      await db.execute(
        sql`INSERT INTO users (id, email) VALUES (${GUEST_USER_ID}, ${GUEST_USER_EMAIL})
            ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      );
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
      token = await mintToken(privateKey, USER_ID, USER_EMAIL);
      guestToken = await mintToken(privateKey, GUEST_USER_ID, GUEST_USER_EMAIL);
    });

    // One combined step for BOTH tenants (rather than the same parametrised
    // line repeated twice): @amiceli/vitest-cucumber only satisfies one
    // occurrence per literal step text within a single Background.
    And(
      'admin-gdpr tenants {string} and {string} each exist with the caller as an admin member',
      async (_c, slugA: string, slugB: string) => {
        await seedTenant(slugA);
        await seedTenant(slugB);
      },
    );

    And(
      'every tenant-scoped table has one fixture row for both {string} and {string}',
      async (_c, slugA: string, slugB: string) => {
        await seedAllTablesForTenant(db, tenantIds[slugA]!);
        await seedAllTablesForTenant(db, tenantIds[slugB]!);
        await snapshotCounts(slugA);
        await snapshotCounts(slugB);
      },
    );
  });

  // ─── Scenario: export tenant isolation ───────────────────────────────────

  Scenario("Export returns only the caller's own tenant data", ({ When, Then, And }) => {
    When('the caller exports data for tenant {string}', async (_c, slug: string) => {
      const res = await app.request('/api/admin/export', { headers: headers(slug) });
      lastExport = {
        status: res.status,
        headers: res.headers,
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
      };
    });

    Then('the export response status is {int}', (_c, n: number) => {
      expect(lastExport.status).toBe(n);
    });

    And('the export response is a downloadable JSON file', () => {
      const disposition = lastExport.headers.get('Content-Disposition') ?? '';
      expect(disposition).toContain('attachment');
      expect(disposition).toContain('.json');
    });

    And(
      'every exported table for {string} contains only {string} rows',
      (_c, slugA: string, slugB: string) => {
        expect(slugA).toBe(slugB);
        const tenantId = tenantIds[slugA]!;
        const data = lastExport.body['data'] as Record<string, unknown[]>;
        for (const table of TENANT_SCOPED_TABLES) {
          const name = getTableConfig(table).name;
          const key = name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
          const rows = data[key];
          const expectedCount = baselineCounts[slugA]![name]!;
          expect(rows, `[FHS-435] export payload missing table "${key}"`).toBeDefined();
          expect(rows, `[FHS-435] "${key}" expected ${expectedCount} row(s)`).toHaveLength(
            expectedCount,
          );
          for (const row of rows!) {
            expect(
              (row as Record<string, unknown>)['tenantId'],
              `[FHS-435] "${key}" row leaked another tenant`,
            ).toBe(tenantId);
          }
        }
      },
    );
  });

  // ─── Scenario: export admin-only ─────────────────────────────────────────

  Scenario('Export is admin-only', ({ Given, When, Then }) => {
    Given(
      'the {string} tenant has a guest member {string}',
      async (_c, slug: string, name: string) => {
        await seedGuest(slug, name);
      },
    );

    When('a guest caller exports data for tenant {string}', async (_c, slug: string) => {
      const res = await app.request('/api/admin/export', { headers: headers(slug, GUEST_USER_ID) });
      lastExport = {
        status: res.status,
        headers: res.headers,
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
      };
    });

    Then('the export response status is {int}', (_c, n: number) => {
      expect(lastExport.status).toBe(n);
    });
  });

  // ─── Scenario: delete-account wrong confirmation ─────────────────────────

  Scenario(
    'Delete-account with the wrong confirmation is rejected and deletes nothing',
    ({ When, Then, And }) => {
      When(
        'the caller deletes the account for tenant {string} confirming {string}',
        async (_c, slug: string, confirm: string) => {
          const res = await app.request('/api/admin/delete-account', {
            method: 'POST',
            headers: headers(slug),
            body: JSON.stringify({ confirm }),
          });
          lastDelete = {
            status: res.status,
            body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
          };
        },
      );

      Then('the delete-account response status is {int}', (_c, n: number) => {
        expect(lastDelete.status).toBe(n);
      });

      And('the delete-account response errorCode is {string}', (_c, code: string) => {
        expect(lastDelete.body['errorCode']).toBe(code);
      });

      And(
        'every tenant-scoped table still has its fixture row for tenant {string}',
        async (_c, slug: string) => {
          const tenantId = tenantIds[slug]!;
          for (const table of TENANT_SCOPED_TABLES) {
            const name = getTableConfig(table).name;
            const count = await tenantRowCount(name, tenantId);
            const expectedCount = baselineCounts[slug]![name]!;
            expect(
              count,
              `[FHS-435] "${name}" expected ${expectedCount} row(s) for ${slug} after a rejected delete`,
            ).toBe(expectedCount);
          }
        },
      );

      And('tenant {string} still exists', async (_c, slug: string) => {
        expect(await tenantExists(tenantIds[slug]!)).toBe(true);
      });
    },
  );

  // ─── Scenario: delete-account admin-only ─────────────────────────────────

  Scenario('Delete-account is admin-only', ({ Given, When, Then, And }) => {
    Given(
      'the {string} tenant has a guest member {string}',
      async (_c, slug: string, name: string) => {
        await seedGuest(slug, name);
      },
    );

    When(
      'a guest caller deletes the account for tenant {string} confirming {string}',
      async (_c, slug: string, confirm: string) => {
        const res = await app.request('/api/admin/delete-account', {
          method: 'POST',
          headers: headers(slug, GUEST_USER_ID),
          body: JSON.stringify({ confirm }),
        });
        lastDelete = {
          status: res.status,
          body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
        };
      },
    );

    Then('the delete-account response status is {int}', (_c, n: number) => {
      expect(lastDelete.status).toBe(n);
    });

    And('tenant {string} still exists', async (_c, slug: string) => {
      expect(await tenantExists(tenantIds[slug]!)).toBe(true);
    });
  });

  // ─── Scenario: delete-account correct confirmation: full cascade ────────

  Scenario(
    'Delete-account with the correct confirmation removes the tenant and everything it owns',
    ({ When, Then, And }) => {
      let jonesTenantIdBeforeDelete: string;
      let smithTenantId: string;

      When(
        'the caller deletes the account for tenant {string} confirming {string}',
        async (_c, slug: string, confirm: string) => {
          jonesTenantIdBeforeDelete = tenantIds[slug]!;
          smithTenantId = tenantIds['smith']!;
          const res = await app.request('/api/admin/delete-account', {
            method: 'POST',
            headers: headers(slug),
            body: JSON.stringify({ confirm }),
          });
          lastDelete = {
            status: res.status,
            body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
          };
        },
      );

      Then('the delete-account response status is {int}', (_c, n: number) => {
        expect(lastDelete.status).toBe(n);
      });

      And('tenant {string} no longer exists', async () => {
        expect(await tenantExists(jonesTenantIdBeforeDelete)).toBe(false);
      });

      And('every tenant-scoped table has zero rows for tenant {string}', async () => {
        for (const table of TENANT_SCOPED_TABLES) {
          const name = getTableConfig(table).name;
          const count = await tenantRowCount(name, jonesTenantIdBeforeDelete);
          expect(count, `[FHS-435] "${name}" still has rows for the deleted tenant`).toBe(0);
        }
      });

      And("the caller's users-mirror row still exists", async () => {
        // Deleting the tenant cascades the `members` row (tenant ↔ user
        // link), but the GLOBAL `users` row (Supabase auth identity) must
        // survive: this endpoint never touches Supabase auth.
        const { rows } = await db.execute<{ id: string }>(
          sql.raw(`SELECT id FROM users WHERE id = '${USER_ID}'`),
        );
        expect(rows).toHaveLength(1);
      });

      And('tenant {string} still exists', async () => {
        expect(await tenantExists(smithTenantId)).toBe(true);
      });

      And('every tenant-scoped table still has its fixture row for tenant {string}', async () => {
        for (const table of TENANT_SCOPED_TABLES) {
          const name = getTableConfig(table).name;
          const count = await tenantRowCount(name, smithTenantId);
          const expectedCount = baselineCounts['smith']![name]!;
          expect(
            count,
            `[FHS-435] "${name}" expected ${expectedCount} untouched row(s) for smith`,
          ).toBe(expectedCount);
        }
      });
    },
  );
});
