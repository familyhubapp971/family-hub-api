/**
 * Step bindings for kid-profile.feature (FHS-362).
 *
 * The kid dashboard header (GET /api/kid/profile) returns the kid's OWN name,
 * avatar, and banked stars/cash: scoped to their member from the kid token,
 * never a sibling's. Real kid token against real Postgres.
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
  // FHS-354: pin is a no-op here (tests run as the superuser, which bypasses RLS).
  pinRequestTenant: async () => {},
}));

import { config } from '../../../apps/api/src/config.js';
import { kidRouter } from '../../../apps/api/src/routes/kid.js';
import { tenants, members, mwSavings } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';

const KID_ISSUER = 'family-hub-kid-auth';
const KID_AVATAR = '🦊';

let db: Database;
let app: Hono;
const tokens = new Map<string, string>();
let res: Response;
let body: {
  displayName: string;
  avatarEmoji: string | null;
  savedStickers: number;
  savedCash: number;
  currency: string;
};

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
  new URL('../features/kid-profile.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    Given(
      'a family with kids "Iman" (12 stars, 5.00 cash, avatar) and "Yusuf" (0 stars)',
      async () => {
        db = getTestDb() as unknown as Database;
        await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
        const [t] = await db
          .insert(tenants)
          .values({
            slug: `kidprofile-${randomUUID().slice(0, 8)}`,
            name: 'Profile Fam',
            currency: 'AED',
          })
          .returning();
        const [iman] = await db
          .insert(members)
          .values({
            tenantId: t!.id,
            displayName: 'Iman',
            role: 'child',
            isChild: true,
            avatarEmoji: KID_AVATAR,
          })
          .returning();
        const [yusuf] = await db
          .insert(members)
          .values({ tenantId: t!.id, displayName: 'Yusuf', role: 'child', isChild: true })
          .returning();
        // Iman has savings; Yusuf has none (no row → 0/0).
        await db
          .insert(mwSavings)
          .values({ tenantId: t!.id, memberId: iman!.id, savedStickers: 12, savedCash: '5.00' });
        tokens.set('Iman', await mintKidToken(iman!.id, t!.id, t!.slug));
        tokens.set('Yusuf', await mintKidToken(yusuf!.id, t!.id, t!.slug));
        app = new Hono();
        app.route('/api/kid', kidRouter);
      },
    );
  });

  Scenario('a kid sees their own profile in the header', ({ When, Then, And }) => {
    When('the kid "Iman" GETs /api/kid/profile with their token', async () => {
      res = await app.request('/api/kid/profile', {
        headers: { Authorization: `Bearer ${tokens.get('Iman')}` },
      });
      body = (await res.json()) as typeof body;
    });
    Then('the kid profile response status is 200', () => {
      expect(res.status).toBe(200);
    });
    And('the kid profile name is "Iman"', () => {
      expect(body.displayName).toBe('Iman');
    });
    And("the kid profile avatar is the kid's avatar", () => {
      expect(body.avatarEmoji).toBe(KID_AVATAR);
    });
    And('the kid profile banked stars is 12', () => {
      expect(body.savedStickers).toBe(12);
    });
    And('the kid profile banked cash is 5', () => {
      expect(body.savedCash).toBe(5);
    });
    And('the kid profile currency is "AED"', () => {
      expect(body.currency).toBe('AED');
    });
  });

  Scenario(
    "a kid's profile is scoped to their own member, never a sibling's",
    ({ When, Then, And }) => {
      When('the kid "Yusuf" GETs /api/kid/profile with their token', async () => {
        res = await app.request('/api/kid/profile', {
          headers: { Authorization: `Bearer ${tokens.get('Yusuf')}` },
        });
        body = (await res.json()) as typeof body;
      });
      Then('the kid profile response status is 200', () => {
        expect(res.status).toBe(200);
      });
      And('the kid profile name is "Yusuf"', () => {
        expect(body.displayName).toBe('Yusuf');
      });
      And('the kid profile banked stars is 0', () => {
        expect(body.savedStickers).toBe(0);
      });
    },
  );
});
