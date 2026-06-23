/**
 * Step bindings for kid-rewards.feature (FHS-374).
 *
 * The kid reads the family rewards + their own star balance (read-only since
 * FHS-374 — POST /redeem was removed; redemption is parent-approved in
 * FHS-376). Real kid token against real Postgres.
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
let res: Response;
let body: Record<string, unknown>;

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
        await db.insert(rewards).values({ tenantId: t!.id, name: 'Ice Cream', stickerCost: 5 });
        await db.insert(rewards).values({ tenantId: t!.id, name: 'Big Prize', stickerCost: 100 });
        kidToken = await mintKidToken(iman!.id, t!.id, t!.slug);
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
});
