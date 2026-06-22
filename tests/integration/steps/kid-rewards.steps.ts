/**
 * Step bindings for kid-rewards.feature (FHS-364).
 *
 * The kid reads the family rewards + their own balance/savings and claims a
 * reward with their own stars (self-scoped redeem, shared money logic). Real
 * kid token against real Postgres.
 */

import { randomUUID } from 'node:crypto';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
  pinRequestTenant: async () => {},
}));

import { config } from '../../../apps/api/src/config.js';
import { kidRouter } from '../../../apps/api/src/routes/kid.js';
import { tenants, members, rewards, mwSavings } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';

const KID_ISSUER = 'family-hub-kid-auth';

let db: Database;
let app: Hono;
let kidToken: string;
let iceCreamId: string;
let bigPrizeId: string;
let otherFamilyRewardId: string;
let res: Response;
let body: Record<string, unknown>;
let redeemRes: Response;
let redeemBody: { stickerBalance?: number };

async function mintKidToken(memberId: string, tenantId: string, slug: string): Promise<string> {
  const secret = new TextEncoder().encode(config.KID_AUTH_SECRET);
  return new SignJWT({ tenantId, tenantSlug: slug, scope: 'child' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(memberId)
    .setIssuer(KID_ISSUER)
    .setExpirationTime('1h')
    .sign(secret);
}

const feature = await loadFeature(
  new URL('../features/kid-rewards.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    Given(
      'a kid "Iman" with 8 saved stars, a reward "Ice Cream" (5 stars), and "Big Prize" (100 stars)',
      async () => {
        db = getTestDb() as unknown as Database;
        await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
        const [t] = await db
          .insert(tenants)
          .values({
            slug: `kidrewards-${randomUUID().slice(0, 8)}`,
            name: 'Reward Fam',
            currency: 'AED',
          })
          .returning();
        const [iman] = await db
          .insert(members)
          .values({ tenantId: t!.id, displayName: 'Iman', role: 'child', isChild: true })
          .returning();
        await db
          .insert(mwSavings)
          .values({ tenantId: t!.id, memberId: iman!.id, savedStickers: 8 });
        const [ice] = await db
          .insert(rewards)
          .values({ tenantId: t!.id, name: 'Ice Cream', stickerCost: 5 })
          .returning();
        const [big] = await db
          .insert(rewards)
          .values({ tenantId: t!.id, name: 'Big Prize', stickerCost: 100 })
          .returning();
        iceCreamId = ice!.id;
        bigPrizeId = big!.id;
        kidToken = await mintKidToken(iman!.id, t!.id, t!.slug);
        // A second family with its own reward — Iman must never reach it.
        const [other] = await db
          .insert(tenants)
          .values({ slug: `other-${randomUUID().slice(0, 8)}`, name: 'Other Fam' })
          .returning();
        const [otherReward] = await db
          .insert(rewards)
          .values({ tenantId: other!.id, name: 'Their Toy', stickerCost: 1 })
          .returning();
        otherFamilyRewardId = otherReward!.id;
        app = new Hono();
        app.route('/api/kid', kidRouter);
      },
    );
  });

  Scenario('a kid sees the rewards with their balance', ({ When, Then, And }) => {
    When('the kid GETs /api/kid/rewards', async () => {
      res = await app.request('/api/kid/rewards', {
        headers: { Authorization: `Bearer ${kidToken}` },
      });
      body = (await res.json()) as Record<string, unknown>;
    });
    Then('the kid rewards response status is 200', () => {
      expect(res.status).toBe(200);
    });
    And('the kid rewards include "Ice Cream"', () => {
      const names = (body.rewards as Array<{ name: string }>).map((r) => r.name);
      expect(names).toContain('Ice Cream');
    });
    And('the kid sticker balance is 8', () => {
      expect(body.stickerBalance).toBe(8);
    });
  });

  Scenario('a kid sees their savings', ({ When, Then, And }) => {
    When('the kid GETs /api/kid/financial', async () => {
      res = await app.request('/api/kid/financial', {
        headers: { Authorization: `Bearer ${kidToken}` },
      });
      body = (await res.json()) as Record<string, unknown>;
    });
    Then('the kid financial response status is 200', () => {
      expect(res.status).toBe(200);
    });
    And('the kid saved stars is 8', () => {
      expect(body.savedStickers).toBe(8);
    });
  });

  Scenario('a kid claims an affordable reward', ({ When, Then, And }) => {
    When('the kid redeems "Ice Cream"', async () => {
      redeemRes = await app.request(`/api/kid/rewards/${iceCreamId}/redeem`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kidToken}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      redeemBody = (await redeemRes.json()) as { stickerBalance?: number };
    });
    Then('the redeem response status is 201', () => {
      expect(redeemRes.status).toBe(201);
    });
    And('the redeemed balance is 3', () => {
      expect(redeemBody.stickerBalance).toBe(3);
    });
  });

  Scenario("a kid cannot claim a reward they can't afford", ({ When, Then }) => {
    When('the kid redeems "Big Prize"', async () => {
      redeemRes = await app.request(`/api/kid/rewards/${bigPrizeId}/redeem`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kidToken}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
    });
    Then('the redeem response status is 409', () => {
      expect(redeemRes.status).toBe(409);
    });
  });

  Scenario('a kid cannot claim a reward from another family', ({ When, Then }) => {
    When('the kid redeems a reward belonging to another family', async () => {
      redeemRes = await app.request(`/api/kid/rewards/${otherFamilyRewardId}/redeem`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kidToken}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
    });
    Then('the redeem response status is 404', () => {
      expect(redeemRes.status).toBe(404);
    });
  });
});
