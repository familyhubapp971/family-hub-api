/**
 * Step bindings for kid-stats.feature (FHS-369).
 *
 * The kid's My World analytics, scoped to themselves — never a sibling's. Real
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
import {
  tenants,
  members,
  habits,
  mwWeeks,
  habitStickers,
} from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';

const KID_ISSUER = 'family-hub-kid-auth';

let db: Database;
let app: Hono;
const tokens = new Map<string, string>();
let res: Response;
let body: {
  stickersPerWeek: Array<{ daysCompleted: number }>;
  habitStats: Array<{ name: string }>;
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
  new URL('../features/kid-stats.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    Given(
      'a kid "Iman" with habit "Read a book" and a sticker this week, plus sibling "Yusuf"',
      async () => {
        db = getTestDb() as unknown as Database;
        await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
        const [t] = await db
          .insert(tenants)
          .values({ slug: `kidstats-${randomUUID().slice(0, 8)}`, name: 'Stats Fam' })
          .returning();
        const [iman] = await db
          .insert(members)
          .values({ tenantId: t!.id, displayName: 'Iman', role: 'child', isChild: true })
          .returning();
        const [yusuf] = await db
          .insert(members)
          .values({ tenantId: t!.id, displayName: 'Yusuf', role: 'child', isChild: true })
          .returning();
        const [habit] = await db
          .insert(habits)
          .values({ tenantId: t!.id, memberId: iman!.id, name: 'Read a book' })
          .returning();
        const [week] = await db
          .insert(mwWeeks)
          .values({
            tenantId: t!.id,
            memberId: iman!.id,
            weekNumber: 25,
            year: 2026,
            startDate: '2026-06-15',
          })
          .returning();
        await db.insert(habitStickers).values({
          tenantId: t!.id,
          memberId: iman!.id,
          habitId: habit!.id,
          weekId: week!.id,
          day: 0,
          sticker: 'gold-star',
          stickerValue: 1,
        });
        tokens.set('Iman', await mintKidToken(iman!.id, t!.id, t!.slug));
        tokens.set('Yusuf', await mintKidToken(yusuf!.id, t!.id, t!.slug));
        app = new Hono();
        app.route('/api/kid', kidRouter);
      },
    );
  });

  Scenario('a kid sees their habit analytics', ({ When, Then, And }) => {
    When('the kid "Iman" GETs /api/kid/analytics', async () => {
      res = await app.request('/api/kid/analytics', {
        headers: { Authorization: `Bearer ${tokens.get('Iman')}` },
      });
      body = (await res.json()) as typeof body;
    });
    Then('the kid analytics response status is 200', () => expect(res.status).toBe(200));
    And('the kid habit stats include "Read a book"', () => {
      expect(body.habitStats.map((h) => h.name)).toContain('Read a book');
    });
    And('the kid stars earned is at least 1', () => {
      const stars = body.stickersPerWeek.reduce((s, w) => s + w.daysCompleted, 0);
      expect(stars).toBeGreaterThanOrEqual(1);
    });
  });

  Scenario("a kid's analytics never include a sibling's habits", ({ When, Then, And }) => {
    When('the kid "Yusuf" GETs /api/kid/analytics', async () => {
      res = await app.request('/api/kid/analytics', {
        headers: { Authorization: `Bearer ${tokens.get('Yusuf')}` },
      });
      body = (await res.json()) as typeof body;
    });
    Then('the kid analytics response status is 200', () => expect(res.status).toBe(200));
    And('the kid habit stats do not include "Read a book"', () => {
      expect(body.habitStats.map((h) => h.name)).not.toContain('Read a book');
    });
  });
});
