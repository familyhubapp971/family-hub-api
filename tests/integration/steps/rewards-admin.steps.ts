/**
 * Step bindings for rewards-admin.feature (FHS-483).
 *
 * Real Postgres + a real signed JWT through authMiddleware (same pattern as
 * admin-panel.steps.ts) — exercises the actual admin-only guard chain
 * (auth -> tenant context -> tenant member -> admin role) rather than a
 * mocked db. Two tenants + two callers cover the mandatory tenant-isolation
 * scenario: a reward created under "khans" must be invisible and
 * unmodifiable from "smiths", even though caller "Priya" is a genuine admin
 * of her own tenant.
 */

import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql, eq } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { rewardsRouter } from '../../../apps/api/src/routes/rewards.js';
import { tenants, members, rewards, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(
  new URL('../features/rewards-admin.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'rewards-admin-int-kid';
const USER_ID = '00000000-0000-4000-8000-000000000483';
const USER_EMAIL = 'rewardsadmin@example.com';
// Second, genuinely-different caller for the tenant-isolation scenario.
const PRIYA_USER_ID = '00000000-0000-4000-8000-000000004831';
const PRIYA_EMAIL = 'priya@example.com';
// A non-admin "adult" member sharing the primary caller's login, used to
// exercise the 403 ADMIN_ONLY path without minting a third token.
const ADULT_USER_ID = '00000000-0000-4000-8000-000000004832';
const ADULT_EMAIL = 'auntrose@example.com';

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
  let priyaToken: string;
  let adultToken: string;
  const tenantIds: Record<string, string> = {};
  const rewardIds: Record<string, string> = {};
  let currentRewardId: string;

  let lastCreate: { status: number; body: Record<string, unknown> };
  let lastUpdate: { status: number; body: Record<string, unknown> };
  let lastDelete: { status: number; body: Record<string, unknown> };
  let lastCrossUpdate: { status: number; body: Record<string, unknown> };
  let lastCrossDelete: { status: number; body: Record<string, unknown> };

  function headers(slug: string, bearer = token) {
    return {
      Authorization: `Bearer ${bearer}`,
      'x-test-tenant': tenantIds[slug]!,
      'Content-Type': 'application/json',
    };
  }

  async function seedTenant(slug: string, userId: string, displayName = 'Caller') {
    const [tenant] = await db
      .insert(tenants)
      .values({ slug, name: `${slug} Family` })
      .returning();
    tenantIds[slug] = tenant!.id;
    await db.insert(members).values({ tenantId: tenant!.id, userId, displayName, role: 'admin' });
  }

  async function seedAdult(slug: string, name: string) {
    await db
      .insert(members)
      .values({
        tenantId: tenantIds[slug]!,
        userId: ADULT_USER_ID,
        displayName: name,
        role: 'adult',
      });
  }

  async function ensureUser(userId: string, email: string) {
    await db.execute(
      sql`INSERT INTO users (id, email) VALUES (${userId}, ${email})
          ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
    );
  }

  Background(({ Given, And }) => {
    Given('the test Postgres has clean rewards-admin tables', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      await db.execute(
        sql`DELETE FROM users WHERE id IN (${USER_ID}, ${PRIYA_USER_ID}, ${ADULT_USER_ID})`,
      );
      _resetJwksCacheForTests();
      for (const m of [tenantIds, rewardIds]) {
        for (const k of Object.keys(m)) delete m[k];
      }
    });

    And('a users mirror row exists for the rewards-admin test caller', async () => {
      await ensureUser(USER_ID, USER_EMAIL);
      await ensureUser(PRIYA_USER_ID, PRIYA_EMAIL);
      await ensureUser(ADULT_USER_ID, ADULT_EMAIL);
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
      app.route('/api/rewards', rewardsRouter);
      token = await mintToken(privateKey, USER_ID, USER_EMAIL);
      priyaToken = await mintToken(privateKey, PRIYA_USER_ID, PRIYA_EMAIL);
      adultToken = await mintToken(privateKey, ADULT_USER_ID, ADULT_EMAIL);
    });

    And(
      'a rewards-admin tenant {string} exists with the caller as an admin member',
      async (_c, slug: string) => {
        await seedTenant(slug, USER_ID);
      },
    );
  });

  // Scenario: create ————————————————————————————————————————————————————————

  Scenario('An admin creates a reward', ({ When, Then, And }) => {
    When(
      'the caller creates a reward {string} costing {int} stickers for tenant {string}',
      async (_c, name: string, cost: number, slug: string) => {
        const res = await app.request('/api/rewards', {
          method: 'POST',
          headers: headers(slug),
          body: JSON.stringify({ name, stickerCost: cost }),
        });
        lastCreate = {
          status: res.status,
          body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
        };
        if (res.status === 201) {
          currentRewardId = lastCreate.body['id'] as string;
          rewardIds[name] = currentRewardId;
        }
      },
    );
    Then('the create-reward response status is {int}', (_c, n: number) =>
      expect(lastCreate.status).toBe(n),
    );
    And('the create-reward response reward name is {string}', (_c, name: string) =>
      expect(lastCreate.body['name']).toBe(name),
    );
    And('the create-reward response sticker cost is {int}', (_c, cost: number) =>
      expect(lastCreate.body['stickerCost']).toBe(cost),
    );
  });

  // Scenario: non-admin rejected on create ————————————————————————————————————

  Scenario('A non-admin adult is rejected on create', ({ Given, When, Then }) => {
    Given(
      'the {string} tenant has an adult member {string}',
      async (_c, slug: string, name: string) => {
        await seedAdult(slug, name);
      },
    );
    When(
      'an adult caller tries to create a reward for tenant {string}',
      async (_c, slug: string) => {
        const res = await app.request('/api/rewards', {
          method: 'POST',
          headers: headers(slug, adultToken),
          body: JSON.stringify({ name: 'Should not exist', stickerCost: 1 }),
        });
        lastCreate = {
          status: res.status,
          body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
        };
      },
    );
    Then('the create-reward adult response status is {int}', (_c, n: number) =>
      expect(lastCreate.status).toBe(n),
    );
  });

  // Scenario: update ————————————————————————————————————————————————————————

  Scenario('An admin partially updates a reward', ({ Given, When, Then, And }) => {
    Given(
      'the caller creates a reward {string} costing {int} stickers for tenant {string}',
      async (_c, name: string, cost: number, slug: string) => {
        const res = await app.request('/api/rewards', {
          method: 'POST',
          headers: headers(slug),
          body: JSON.stringify({ name, stickerCost: cost }),
        });
        const b = (await res.json()) as Record<string, unknown>;
        currentRewardId = b['id'] as string;
        rewardIds[name] = currentRewardId;
      },
    );
    When("the caller updates the reward's sticker cost to {int}", async (_c, cost: number) => {
      const res = await app.request(`/api/rewards/${currentRewardId}`, {
        method: 'PATCH',
        headers: headers('khans'),
        body: JSON.stringify({ stickerCost: cost }),
      });
      lastUpdate = {
        status: res.status,
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
      };
    });
    Then('the update-reward response status is {int}', (_c, n: number) =>
      expect(lastUpdate.status).toBe(n),
    );
    And('the update-reward response sticker cost is {int}', (_c, cost: number) =>
      expect(lastUpdate.body['stickerCost']).toBe(cost),
    );
    And('the update-reward response reward name is {string}', (_c, name: string) =>
      expect(lastUpdate.body['name']).toBe(name),
    );
  });

  // Scenario: update 404 ————————————————————————————————————————————————————

  Scenario('Update returns 404 for a reward id that does not exist', ({ When, Then }) => {
    When('the caller updates an unknown reward id', async () => {
      const res = await app.request('/api/rewards/99999999-9999-4999-8999-999999999999', {
        method: 'PATCH',
        headers: headers('khans'),
        body: JSON.stringify({ stickerCost: 5 }),
      });
      lastUpdate = {
        status: res.status,
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
      };
    });
    Then('the update-reward response status is {int}', (_c, n: number) =>
      expect(lastUpdate.status).toBe(n),
    );
  });

  // Scenario: non-admin rejected on update ————————————————————————————————————

  Scenario('A non-admin adult is rejected on update', ({ Given, And, When, Then }) => {
    Given(
      'the {string} tenant has an adult member {string}',
      async (_c, slug: string, name: string) => {
        await seedAdult(slug, name);
      },
    );
    And(
      'the caller creates a reward {string} costing {int} stickers for tenant {string}',
      async (_c, name: string, cost: number, slug: string) => {
        const res = await app.request('/api/rewards', {
          method: 'POST',
          headers: headers(slug),
          body: JSON.stringify({ name, stickerCost: cost }),
        });
        const b = (await res.json()) as Record<string, unknown>;
        currentRewardId = b['id'] as string;
        rewardIds[name] = currentRewardId;
      },
    );
    When(
      "an adult caller tries to update the reward's sticker cost to {int}",
      async (_c, cost: number) => {
        const res = await app.request(`/api/rewards/${currentRewardId}`, {
          method: 'PATCH',
          headers: headers('khans', adultToken),
          body: JSON.stringify({ stickerCost: cost }),
        });
        lastUpdate = {
          status: res.status,
          body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
        };
      },
    );
    Then('the update-reward adult response status is {int}', (_c, n: number) =>
      expect(lastUpdate.status).toBe(n),
    );
  });

  // Scenario: archive ———————————————————————————————————————————————————————

  Scenario('An admin archives (soft-deletes) a reward', ({ Given, When, Then, And }) => {
    Given(
      'the caller creates a reward {string} costing {int} stickers for tenant {string}',
      async (_c, name: string, cost: number, slug: string) => {
        const res = await app.request('/api/rewards', {
          method: 'POST',
          headers: headers(slug),
          body: JSON.stringify({ name, stickerCost: cost }),
        });
        const b = (await res.json()) as Record<string, unknown>;
        currentRewardId = b['id'] as string;
        rewardIds[name] = currentRewardId;
      },
    );
    When('the caller deletes the reward', async () => {
      const res = await app.request(`/api/rewards/${currentRewardId}`, {
        method: 'DELETE',
        headers: headers('khans'),
      });
      lastDelete = {
        status: res.status,
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
      };
    });
    Then('the delete-reward response status is {int}', (_c, n: number) =>
      expect(lastDelete.status).toBe(n),
    );
    And(
      'the reward no longer appears in the family rewards list for tenant {string}',
      async (_c, slug: string) => {
        // Any tenant member id satisfies GET /api/rewards's memberId param —
        // the caller's own membership row is used here.
        const [memberRow] = await db
          .select({ id: members.id })
          .from(members)
          .where(eq(members.tenantId, tenantIds[slug]!));
        const res = await app.request(`/api/rewards?memberId=${memberRow!.id}`, {
          headers: headers(slug),
        });
        const body = (await res.json()) as { rewards: { id: string }[] };
        expect(body.rewards.some((r) => r.id === currentRewardId)).toBe(false);
      },
    );
    And('the reward row still exists in the database with archived_at set', async () => {
      const [row] = await db.select().from(rewards).where(eq(rewards.id, currentRewardId));
      expect(row).toBeDefined();
      expect(row!.archivedAt).not.toBeNull();
    });
  });

  // Scenario: delete already-archived returns 404 —————————————————————————————

  Scenario('Deleting an already-archived reward returns 404', ({ Given, And, When, Then }) => {
    Given(
      'the caller creates a reward {string} costing {int} stickers for tenant {string}',
      async (_c, name: string, cost: number, slug: string) => {
        const res = await app.request('/api/rewards', {
          method: 'POST',
          headers: headers(slug),
          body: JSON.stringify({ name, stickerCost: cost }),
        });
        const b = (await res.json()) as Record<string, unknown>;
        currentRewardId = b['id'] as string;
        rewardIds[name] = currentRewardId;
      },
    );
    And('the caller deletes the reward', async () => {
      const res = await app.request(`/api/rewards/${currentRewardId}`, {
        method: 'DELETE',
        headers: headers('khans'),
      });
      lastDelete = {
        status: res.status,
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
      };
    });
    When('the caller deletes the reward again', async () => {
      const res = await app.request(`/api/rewards/${currentRewardId}`, {
        method: 'DELETE',
        headers: headers('khans'),
      });
      lastDelete = {
        status: res.status,
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
      };
    });
    Then('the delete-reward response status is {int}', (_c, n: number) =>
      expect(lastDelete.status).toBe(n),
    );
  });

  // Scenario: non-admin rejected on delete ————————————————————————————————————

  Scenario('A non-admin adult is rejected on delete', ({ Given, And, When, Then }) => {
    Given(
      'the {string} tenant has an adult member {string}',
      async (_c, slug: string, name: string) => {
        await seedAdult(slug, name);
      },
    );
    And(
      'the caller creates a reward {string} costing {int} stickers for tenant {string}',
      async (_c, name: string, cost: number, slug: string) => {
        const res = await app.request('/api/rewards', {
          method: 'POST',
          headers: headers(slug),
          body: JSON.stringify({ name, stickerCost: cost }),
        });
        const b = (await res.json()) as Record<string, unknown>;
        currentRewardId = b['id'] as string;
        rewardIds[name] = currentRewardId;
      },
    );
    When('an adult caller tries to delete the reward', async () => {
      const res = await app.request(`/api/rewards/${currentRewardId}`, {
        method: 'DELETE',
        headers: headers('khans', adultToken),
      });
      lastDelete = {
        status: res.status,
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
      };
    });
    Then('the delete-reward adult response status is {int}', (_c, n: number) =>
      expect(lastDelete.status).toBe(n),
    );
  });

  // Scenario: tenant isolation ——————————————————————————————————————————————

  Scenario(
    "Tenant isolation — another family cannot edit or delete this family's reward",
    ({ Given, And, When, Then }) => {
      Given(
        'a second rewards-admin tenant {string} exists with a different admin caller {string}',
        async (_c, slug: string) => {
          await seedTenant(slug, PRIYA_USER_ID, 'Priya');
        },
      );
      And(
        'the caller creates a reward {string} costing {int} stickers for tenant {string}',
        async (_c, name: string, cost: number, slug: string) => {
          const res = await app.request('/api/rewards', {
            method: 'POST',
            headers: headers(slug),
            body: JSON.stringify({ name, stickerCost: cost }),
          });
          const b = (await res.json()) as Record<string, unknown>;
          currentRewardId = b['id'] as string;
          rewardIds[name] = currentRewardId;
        },
      );
      When(
        "caller {string} tries to update the {string} reward's sticker cost to {int} from tenant {string}",
        async (_c, _callerName: string, _slug: string, cost: number, fromSlug: string) => {
          const res = await app.request(`/api/rewards/${currentRewardId}`, {
            method: 'PATCH',
            headers: headers(fromSlug, priyaToken),
            body: JSON.stringify({ stickerCost: cost }),
          });
          lastCrossUpdate = {
            status: res.status,
            body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
          };
        },
      );
      Then('the cross-tenant update response status is {int}', (_c, n: number) =>
        expect(lastCrossUpdate.status).toBe(n),
      );
      When(
        'caller {string} tries to delete the {string} reward from tenant {string}',
        async (_c, _callerName: string, _slug: string, fromSlug: string) => {
          const res = await app.request(`/api/rewards/${currentRewardId}`, {
            method: 'DELETE',
            headers: headers(fromSlug, priyaToken),
          });
          lastCrossDelete = {
            status: res.status,
            body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
          };
        },
      );
      Then('the cross-tenant delete response status is {int}', (_c, n: number) =>
        expect(lastCrossDelete.status).toBe(n),
      );
      And(
        'the {string} reward {string} still has sticker cost {int}',
        async (_c, _slug, name: string, cost: number) => {
          const [row] = await db.select().from(rewards).where(eq(rewards.id, rewardIds[name]!));
          expect(row!.stickerCost).toBe(cost);
          expect(row!.archivedAt).toBeNull();
        },
      );
      And(
        'the {string} family rewards list does not include {string}',
        async (_c, slug: string, name: string) => {
          const [memberRow] = await db
            .select({ id: members.id })
            .from(members)
            .where(eq(members.tenantId, tenantIds[slug]!));
          const res = await app.request(`/api/rewards?memberId=${memberRow!.id}`, {
            headers: headers(slug, priyaToken),
          });
          const body = (await res.json()) as { rewards: { name: string }[] };
          expect(body.rewards.some((r) => r.name === name)).toBe(false);
        },
      );
    },
  );
});
