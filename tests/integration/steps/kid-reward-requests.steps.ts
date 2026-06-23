/**
 * Step bindings for kid-reward-requests.feature (FHS-376).
 *
 * A kid asks to redeem a reward (kid HS256 token → kidRouter); an admin parent
 * approves/declines (Supabase ES256 token → mwRedemptionRequestsRouter).
 * Approval deducts from the kid's SAVINGS only. Real Postgres throughout.
 */

import { randomUUID } from 'node:crypto';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
  pinRequestTenant: async () => {},
}));

import { config } from '../../../apps/api/src/config.js';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { kidRouter } from '../../../apps/api/src/routes/kid.js';
import { mwRedemptionRequestsRouter } from '../../../apps/api/src/routes/mw-redemption-requests.js';
import {
  tenants,
  members,
  rewards,
  mwSavings,
  redemptionRequests,
  users,
} from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';

const KID_ISSUER = 'family-hub-kid-auth';
const SUPA_ISSUER = 'https://test.supabase.local/auth/v1';
const KID_JWK = 'kid-reward-requests-int-kid';

let db: Database;
let app: Hono; // parent app (Supabase auth + tenant header)
let kidApp: Hono; // kid app (kid HS256 token)

// Per-scenario fixture state.
const ctx: {
  tenantId: string;
  otherTenantId: string;
  imanId: string;
  iceCreamId: string;
  bigPrizeId: string;
  adminToken: string;
  adultToken: string;
  otherAdminToken: string;
  imanKidToken: string;
  requestId: string;
  otherRequestId: string;
  secondRequestId: string;
  lastReqStatus: number;
  lastReqBody: Record<string, unknown>;
  lastDecideStatus: number;
  lastDecideBody: Record<string, unknown>;
  lastListBody: Record<string, unknown>;
  lastRewardsBody: Record<string, unknown>;
  lastJournalStatus: number;
} = {} as never;

// Stable Supabase user ids for the three adult callers.
const ADMIN_USER_ID = '00000000-0000-4000-8000-000000000376';
const ADULT_USER_ID = '00000000-0000-4000-8000-000000003762';
const OTHER_ADMIN_USER_ID = '00000000-0000-4000-8000-000000003763';

let supaPrivateKey: KeyLike;
let supaPublicJwk: JWK;

async function genSupaKey() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = 'ES256';
  publicJwk.kid = KID_JWK;
  publicJwk.use = 'sig';
  return { privateKey, publicJwk };
}

async function mintSupaToken(userId: string, email: string): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'ES256', kid: KID_JWK })
    .setSubject(userId)
    .setIssuer(SUPA_ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(supaPrivateKey);
}

function makeJwks(publicJwk: JWK) {
  return async (header: { kid?: string; alg?: string }) => {
    const { importJWK } = await import('jose');
    if (header.kid !== publicJwk.kid) throw new Error(`no key for kid ${header.kid}`);
    return (await importJWK(publicJwk, header.alg ?? 'ES256')) as KeyLike;
  };
}

async function mintKidToken(memberId: string, tenantId: string, slug: string): Promise<string> {
  const secret = new TextEncoder().encode(config.KID_AUTH_SECRET);
  return new SignJWT({ tenantId, tenantSlug: slug, scope: 'child' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(memberId)
    .setIssuer(KID_ISSUER)
    .setExpirationTime('1h')
    .sign(secret);
}

const resolveTenantFromHeader: MiddlewareHandler = async (c, next) => {
  c.set('tenantId', c.req.header('x-test-tenant'));
  await next();
};

function parentHeaders(token: string, tenantId: string) {
  return {
    Authorization: `Bearer ${token}`,
    'x-test-tenant': tenantId,
    'Content-Type': 'application/json',
  };
}

async function savedStars(memberId: string, tenantId: string): Promise<number> {
  const rows = await db
    .select({ savedStickers: mwSavings.savedStickers })
    .from(mwSavings)
    .where(sql`tenant_id = ${tenantId} AND member_id = ${memberId}`)
    .limit(1);
  return rows[0]?.savedStickers ?? 0;
}

async function requestStatusFromDb(requestId: string): Promise<string | null> {
  const rows = await db
    .select({ status: redemptionRequests.status })
    .from(redemptionRequests)
    .where(sql`id = ${requestId}`)
    .limit(1);
  return rows[0]?.status ?? null;
}

const feature = await loadFeature(
  new URL('../features/kid-reward-requests.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    Given(
      'a family with an admin parent, a non-admin adult, a kid "Iman" with 10 saved stars, and a reward "Ice Cream" (5 stars)',
      async () => {
        db = getTestDb() as unknown as Database;
        await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
        await db.execute(
          sql`DELETE FROM users WHERE id IN (${ADMIN_USER_ID}, ${ADULT_USER_ID}, ${OTHER_ADMIN_USER_ID})`,
        );
        _resetJwksCacheForTests();

        // Supabase key + JWKS for the parent path.
        const k = await genSupaKey();
        supaPrivateKey = k.privateKey;
        supaPublicJwk = k.publicJwk;

        // Users mirror rows for the three adult callers.
        await db.execute(
          sql`INSERT INTO users (id, email) VALUES
              (${ADMIN_USER_ID}, 'admin376@example.com'),
              (${ADULT_USER_ID}, 'adult376@example.com'),
              (${OTHER_ADMIN_USER_ID}, 'otheradmin376@example.com')
              ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
        );

        // Family 1.
        const [t] = await db
          .insert(tenants)
          .values({ slug: `rr-${randomUUID().slice(0, 8)}`, name: 'Request Fam', currency: 'AED' })
          .returning();
        ctx.tenantId = t!.id;
        await db
          .insert(members)
          .values({ tenantId: t!.id, userId: ADMIN_USER_ID, displayName: 'Admin', role: 'admin' });
        await db
          .insert(members)
          .values({ tenantId: t!.id, userId: ADULT_USER_ID, displayName: 'Adult', role: 'adult' });
        const [iman] = await db
          .insert(members)
          .values({ tenantId: t!.id, displayName: 'Iman', role: 'child', isChild: true })
          .returning();
        ctx.imanId = iman!.id;
        await db
          .insert(mwSavings)
          .values({ tenantId: t!.id, memberId: iman!.id, savedStickers: 10 });
        const [ice] = await db
          .insert(rewards)
          .values({ tenantId: t!.id, name: 'Ice Cream', stickerCost: 5, icon: '🍦' })
          .returning();
        ctx.iceCreamId = ice!.id;

        ctx.adminToken = await mintSupaToken(ADMIN_USER_ID, 'admin376@example.com');
        ctx.adultToken = await mintSupaToken(ADULT_USER_ID, 'adult376@example.com');
        ctx.imanKidToken = await mintKidToken(iman!.id, t!.id, t!.slug);

        // Parent app: Supabase auth + tenant header + the redemption-requests router.
        app = new Hono();
        app.use(
          '*',
          authMiddleware({
            issuer: SUPA_ISSUER,
            jwks: makeJwks(supaPublicJwk),
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
        app.route('/api/mw/redemption-requests', mwRedemptionRequestsRouter);

        // Kid app: the kid router carries its own kid-auth middleware.
        kidApp = new Hono();
        kidApp.route('/api/kid', kidRouter);
      },
    );
  });

  // ── helpers shared across scenarios as steps ───────────────────────────────

  async function kidRequest(token: string, rewardId: string) {
    const res = await kidApp.request(`/api/kid/rewards/${rewardId}/request`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
  }

  async function adminApprove(token: string, tenantId: string, requestId: string) {
    const res = await app.request(`/api/mw/redemption-requests/${requestId}/approve`, {
      method: 'POST',
      headers: parentHeaders(token, tenantId),
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
  }

  async function adminDecline(token: string, tenantId: string, requestId: string) {
    const res = await app.request(`/api/mw/redemption-requests/${requestId}/decline`, {
      method: 'POST',
      headers: parentHeaders(token, tenantId),
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
  }

  async function seedSecondFamily() {
    const [t2] = await db
      .insert(tenants)
      .values({ slug: `rr2-${randomUUID().slice(0, 8)}`, name: 'Smiths' })
      .returning();
    ctx.otherTenantId = t2!.id;
    await db.insert(members).values({
      tenantId: t2!.id,
      userId: OTHER_ADMIN_USER_ID,
      displayName: 'Other Admin',
      role: 'admin',
    });
    const [yusuf] = await db
      .insert(members)
      .values({ tenantId: t2!.id, displayName: 'Yusuf', role: 'child', isChild: true })
      .returning();
    const [reward2] = await db
      .insert(rewards)
      .values({ tenantId: t2!.id, name: 'Toy', stickerCost: 3 })
      .returning();
    const [req2] = await db
      .insert(redemptionRequests)
      .values({ tenantId: t2!.id, memberId: yusuf!.id, rewardId: reward2!.id, starCost: 3 })
      .returning({ id: redemptionRequests.id });
    ctx.otherRequestId = req2!.id;
    ctx.otherAdminToken = await mintSupaToken(OTHER_ADMIN_USER_ID, 'otheradmin376@example.com');
  }

  // Scenario: a kid requests a reward and no stars are deducted ───────────────
  Scenario('a kid requests a reward and no stars are deducted', ({ When, Then, And }) => {
    When('the kid "Iman" requests the reward "Ice Cream"', async () => {
      const r = await kidRequest(ctx.imanKidToken, ctx.iceCreamId);
      ctx.lastReqStatus = r.status;
      ctx.lastReqBody = r.body;
      ctx.requestId = r.body['id'] as string;
    });
    Then('the request response status is 200', () => expect(ctx.lastReqStatus).toBe(200));
    And('the request status is "pending"', () => expect(ctx.lastReqBody['status']).toBe('pending'));
    And('the kid "Iman" still has 10 saved stars', async () =>
      expect(await savedStars(ctx.imanId, ctx.tenantId)).toBe(10),
    );
  });

  // Scenario: a duplicate request returns the same pending request ────────────
  Scenario('a duplicate request returns the same pending request', ({ When, Then, And }) => {
    When('the kid "Iman" requests the reward "Ice Cream"', async () => {
      const r = await kidRequest(ctx.imanKidToken, ctx.iceCreamId);
      ctx.requestId = r.body['id'] as string;
    });
    And('the kid "Iman" requests the reward "Ice Cream" again', async () => {
      const r = await kidRequest(ctx.imanKidToken, ctx.iceCreamId);
      ctx.secondRequestId = r.body['id'] as string;
    });
    Then('both requests have the same id', () => expect(ctx.secondRequestId).toBe(ctx.requestId));
    And('there is exactly 1 pending request for the family', async () => {
      const rows = await db
        .select({ id: redemptionRequests.id })
        .from(redemptionRequests)
        .where(sql`tenant_id = ${ctx.tenantId} AND status = 'pending'`);
      expect(rows.length).toBe(1);
    });
  });

  // Scenario: the kid rewards list reflects the request status ────────────────
  Scenario('the kid rewards list reflects the request status', ({ When, Then, And }) => {
    When('the kid "Iman" requests the reward "Ice Cream"', async () => {
      await kidRequest(ctx.imanKidToken, ctx.iceCreamId);
    });
    And('the kid "Iman" GETs their rewards list', async () => {
      const res = await kidApp.request('/api/kid/rewards', {
        headers: { Authorization: `Bearer ${ctx.imanKidToken}` },
      });
      ctx.lastRewardsBody = (await res.json()) as Record<string, unknown>;
    });
    Then('the rewards list shows "Ice Cream" with requestStatus "pending"', () => {
      const rewardsList = ctx.lastRewardsBody['rewards'] as Array<{
        name: string;
        requestStatus: string;
      }>;
      const ice = rewardsList.find((r) => r.name === 'Ice Cream');
      expect(ice?.requestStatus).toBe('pending');
    });
  });

  // Scenario: an admin approves a request ────────────────────────────────────
  Scenario(
    'an admin approves a request and the cost is deducted from savings only',
    ({ Given, When, Then, And }) => {
      Given('the kid "Iman" has requested the reward "Ice Cream"', async () => {
        const r = await kidRequest(ctx.imanKidToken, ctx.iceCreamId);
        ctx.requestId = r.body['id'] as string;
      });
      When('the admin parent approves the request', async () => {
        const r = await adminApprove(ctx.adminToken, ctx.tenantId, ctx.requestId);
        ctx.lastDecideStatus = r.status;
        ctx.lastDecideBody = r.body;
      });
      Then('the approve response status is 200', () => expect(ctx.lastDecideStatus).toBe(200));
      And('the approve response status field is "approved"', () =>
        expect(ctx.lastDecideBody['status']).toBe('approved'),
      );
      And('the kid "Iman" has 5 saved stars', async () =>
        expect(await savedStars(ctx.imanId, ctx.tenantId)).toBe(5),
      );
      And('there is exactly 0 pending request for the family', async () => {
        const rows = await db
          .select({ id: redemptionRequests.id })
          .from(redemptionRequests)
          .where(sql`tenant_id = ${ctx.tenantId} AND status = 'pending'`);
        expect(rows.length).toBe(0);
      });
    },
  );

  // Scenario: a non-admin adult cannot approve ───────────────────────────────
  Scenario('a non-admin adult cannot approve a request', ({ Given, When, Then, And }) => {
    Given('the kid "Iman" has requested the reward "Ice Cream"', async () => {
      const r = await kidRequest(ctx.imanKidToken, ctx.iceCreamId);
      ctx.requestId = r.body['id'] as string;
    });
    When('the non-admin adult approves the request', async () => {
      const r = await adminApprove(ctx.adultToken, ctx.tenantId, ctx.requestId);
      ctx.lastDecideStatus = r.status;
      ctx.lastDecideBody = r.body;
    });
    Then('the approve response status is 403', () => expect(ctx.lastDecideStatus).toBe(403));
    And('the kid "Iman" still has 10 saved stars', async () =>
      expect(await savedStars(ctx.imanId, ctx.tenantId)).toBe(10),
    );
    And('the request status is "pending"', async () =>
      expect(await requestStatusFromDb(ctx.requestId)).toBe('pending'),
    );
  });

  // Scenario: insufficient savings ───────────────────────────────────────────
  Scenario(
    'approval is rejected when savings cannot cover the cost',
    ({ Given, When, Then, And }) => {
      Given('a reward "Big Prize" (100 stars)', async () => {
        const [bp] = await db
          .insert(rewards)
          .values({ tenantId: ctx.tenantId, name: 'Big Prize', stickerCost: 100 })
          .returning();
        ctx.bigPrizeId = bp!.id;
      });
      And('the kid "Iman" has requested the reward "Big Prize"', async () => {
        const r = await kidRequest(ctx.imanKidToken, ctx.bigPrizeId);
        ctx.requestId = r.body['id'] as string;
      });
      When('the admin parent approves the request', async () => {
        const r = await adminApprove(ctx.adminToken, ctx.tenantId, ctx.requestId);
        ctx.lastDecideStatus = r.status;
        ctx.lastDecideBody = r.body;
      });
      Then('the approve response status is 400', () => expect(ctx.lastDecideStatus).toBe(400));
      And('the kid "Iman" still has 10 saved stars', async () =>
        expect(await savedStars(ctx.imanId, ctx.tenantId)).toBe(10),
      );
      And('the request status is "pending"', async () =>
        expect(await requestStatusFromDb(ctx.requestId)).toBe('pending'),
      );
    },
  );

  Scenario(
    'an admin approves when savings exactly cover the cost',
    ({ Given, When, Then, And }) => {
      Given('a reward "Exact Treat" (10 stars)', async () => {
        const [t] = await db
          .insert(rewards)
          .values({ tenantId: ctx.tenantId, name: 'Exact Treat', stickerCost: 10 })
          .returning();
        ctx.bigPrizeId = t!.id;
      });
      And('the kid "Iman" has requested the reward "Exact Treat"', async () => {
        const r = await kidRequest(ctx.imanKidToken, ctx.bigPrizeId);
        ctx.requestId = r.body['id'] as string;
      });
      When('the admin parent approves the request', async () => {
        const r = await adminApprove(ctx.adminToken, ctx.tenantId, ctx.requestId);
        ctx.lastDecideStatus = r.status;
        ctx.lastDecideBody = r.body;
      });
      Then('the approve response status is 200', () => expect(ctx.lastDecideStatus).toBe(200));
      And('the kid "Iman" has 0 saved stars', async () =>
        expect(await savedStars(ctx.imanId, ctx.tenantId)).toBe(0),
      );
    },
  );

  // Scenario: admin declines ─────────────────────────────────────────────────
  Scenario('an admin declines a request with no deduction', ({ Given, When, Then, And }) => {
    Given('the kid "Iman" has requested the reward "Ice Cream"', async () => {
      const r = await kidRequest(ctx.imanKidToken, ctx.iceCreamId);
      ctx.requestId = r.body['id'] as string;
    });
    When('the admin parent declines the request', async () => {
      const r = await adminDecline(ctx.adminToken, ctx.tenantId, ctx.requestId);
      ctx.lastDecideStatus = r.status;
      ctx.lastDecideBody = r.body;
    });
    Then('the decline response status is 200', () => expect(ctx.lastDecideStatus).toBe(200));
    And('the decline response status field is "declined"', () =>
      expect(ctx.lastDecideBody['status']).toBe('declined'),
    );
    And('the kid "Iman" still has 10 saved stars', async () =>
      expect(await savedStars(ctx.imanId, ctx.tenantId)).toBe(10),
    );
  });

  // Scenario: tenant isolation on the parent list ────────────────────────────
  Scenario('the parent list is tenant-isolated', ({ Given, When, Then }) => {
    Given(
      'a second family "Smiths" with an admin parent and a kid "Yusuf" who has requested a reward',
      async () => {
        // Iman requests in family 1 too, so there is a row in each tenant.
        const r = await kidRequest(ctx.imanKidToken, ctx.iceCreamId);
        ctx.requestId = r.body['id'] as string;
        await seedSecondFamily();
      },
    );
    When("the admin parent lists the family's pending requests", async () => {
      const res = await app.request('/api/mw/redemption-requests?status=pending', {
        headers: parentHeaders(ctx.adminToken, ctx.tenantId),
      });
      ctx.lastListBody = (await res.json()) as Record<string, unknown>;
    });
    Then("the list contains only this family's requests", () => {
      const requests = ctx.lastListBody['requests'] as Array<{ id: string; memberName: string }>;
      const ids = requests.map((r) => r.id);
      expect(ids).toContain(ctx.requestId);
      expect(ids).not.toContain(ctx.otherRequestId);
      expect(requests.every((r) => r.memberName !== 'Yusuf')).toBe(true);
    });
  });

  // Scenario: cross-tenant approve is a 404 ──────────────────────────────────
  Scenario("an admin cannot approve another family's request", ({ Given, When, Then }) => {
    Given(
      'a second family "Smiths" with an admin parent and a kid "Yusuf" who has requested a reward',
      async () => {
        await seedSecondFamily();
      },
    );
    When("the admin parent approves the other family's request", async () => {
      // Family 1's admin tries to approve family 2's request id, scoped to family 1.
      const r = await adminApprove(ctx.adminToken, ctx.tenantId, ctx.otherRequestId);
      ctx.lastDecideStatus = r.status;
      ctx.lastDecideBody = r.body;
    });
    Then('the approve response status is 404', () => expect(ctx.lastDecideStatus).toBe(404));
  });

  // Scenario: kid journal write endpoint gone ────────────────────────────────
  Scenario('the kid journal write endpoint is gone', ({ When, Then }) => {
    When('the kid "Iman" PUTs their journal', async () => {
      const res = await kidApp.request('/api/kid/journal', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${ctx.imanKidToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ entryDate: '2026-06-15', mood: 'happy' }),
      });
      ctx.lastJournalStatus = res.status;
    });
    Then('the kid journal write response status is 404', () =>
      expect(ctx.lastJournalStatus).toBe(404),
    );
  });
});
