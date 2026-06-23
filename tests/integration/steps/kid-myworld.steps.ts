/**
 * Step bindings for kid-myworld.feature (FHS-374).
 *
 * Kid read-only My World: weeks list, week stats, week actions, financial
 * savings, and financial investments — all self-scoped, sibling-isolated.
 * Shapes verified to be byte-identical to parent endpoints via shared loaders
 * in lib/myworld.ts. Real kid token against real Postgres.
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
  mwSavings,
} from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';

const KID_ISSUER = 'family-hub-kid-auth';

let db: Database;
let app: Hono;
const tokens = new Map<string, string>();
const weekIds = new Map<string, string>(); // member name -> weekId
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
  new URL('../features/kid-myworld.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    Given(
      'two kids "Iman" and "Yusuf" in the same family, each with a week and some stickers',
      async () => {
        db = getTestDb() as unknown as Database;
        await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
        const [t] = await db
          .insert(tenants)
          .values({
            slug: `kidmw-${randomUUID().slice(0, 8)}`,
            name: 'MyWorld Fam',
            currency: 'AED',
          })
          .returning();

        const [iman] = await db
          .insert(members)
          .values({ tenantId: t!.id, displayName: 'Iman', role: 'child', isChild: true })
          .returning();
        const [yusuf] = await db
          .insert(members)
          .values({ tenantId: t!.id, displayName: 'Yusuf', role: 'child', isChild: true })
          .returning();

        const [imanHabit] = await db
          .insert(habits)
          .values({ tenantId: t!.id, memberId: iman!.id, name: 'Read a book' })
          .returning();
        const [yusufHabit] = await db
          .insert(habits)
          .values({ tenantId: t!.id, memberId: yusuf!.id, name: 'Tidy room' })
          .returning();

        const [imanWeek] = await db
          .insert(mwWeeks)
          .values({
            tenantId: t!.id,
            memberId: iman!.id,
            weekNumber: 25,
            year: 2026,
            startDate: '2026-06-15',
          })
          .returning();
        const [yusufWeek] = await db
          .insert(mwWeeks)
          .values({
            tenantId: t!.id,
            memberId: yusuf!.id,
            weekNumber: 25,
            year: 2026,
            startDate: '2026-06-15',
          })
          .returning();

        // Give Iman 3 stickers so stats are non-zero.
        for (const day of [0, 1, 2]) {
          await db.insert(habitStickers).values({
            tenantId: t!.id,
            memberId: iman!.id,
            habitId: imanHabit!.id,
            weekId: imanWeek!.id,
            day,
            sticker: 'gold-star',
            stickerValue: 1,
          });
        }
        // Give Yusuf one sticker (so sibling isolation is verifiable).
        await db.insert(habitStickers).values({
          tenantId: t!.id,
          memberId: yusuf!.id,
          habitId: yusufHabit!.id,
          weekId: yusufWeek!.id,
          day: 0,
          sticker: 'heart',
          stickerValue: 1,
        });

        // Give Iman banked savings; Yusuf gets none (savedStickers defaults to 0).
        await db
          .insert(mwSavings)
          .values({ tenantId: t!.id, memberId: iman!.id, savedStickers: 5 });

        weekIds.set('Iman', imanWeek!.id);
        weekIds.set('Yusuf', yusufWeek!.id);
        tokens.set('Iman', await mintKidToken(iman!.id, t!.id, t!.slug));
        tokens.set('Yusuf', await mintKidToken(yusuf!.id, t!.id, t!.slug));
        app = new Hono();
        app.route('/api/kid', kidRouter);
      },
    );
  });

  // ── Weeks list ────────────────────────────────────────────────────────────

  Scenario('a kid reads their weeks list', ({ When, Then, And }) => {
    let weekIdList: string[] = [];
    When('kid "Iman" GETs /api/kid/weeks', async () => {
      res = await app.request('/api/kid/weeks', {
        headers: { Authorization: `Bearer ${tokens.get('Iman')}` },
      });
      body = (await res.json()) as Record<string, unknown>;
      weekIdList = (body.weeks as Array<{ id: string }>).map((w) => w.id);
    });
    Then('the kid weeks response status is 200', () => expect(res.status).toBe(200));
    And("the weeks list includes Iman's week", () => {
      expect(weekIdList).toContain(weekIds.get('Iman'));
    });
    And("the weeks list does not include Yusuf's week", () => {
      expect(weekIdList).not.toContain(weekIds.get('Yusuf'));
    });
  });

  // ── Week stats ────────────────────────────────────────────────────────────

  Scenario('a kid reads week stats for their own week', ({ When, Then, And }) => {
    When('kid "Iman" GETs /api/kid/weeks/:id/stats for their week', async () => {
      res = await app.request(`/api/kid/weeks/${weekIds.get('Iman')}/stats`, {
        headers: { Authorization: `Bearer ${tokens.get('Iman')}` },
      });
      body = (await res.json()) as Record<string, unknown>;
    });
    Then('the kid week stats response status is 200', () => expect(res.status).toBe(200));
    And('the week stats contain a totalStickers field', () => {
      expect(typeof body.totalStickers).toBe('number');
      // Iman has 3 stickers seeded.
      expect(body.totalStickers as number).toBeGreaterThanOrEqual(3);
    });
  });

  Scenario("a kid gets 404 for a sibling's week stats", ({ When, Then }) => {
    When('kid "Iman" requests week stats for Yusuf\'s week', async () => {
      res = await app.request(`/api/kid/weeks/${weekIds.get('Yusuf')}/stats`, {
        headers: { Authorization: `Bearer ${tokens.get('Iman')}` },
      });
    });
    Then('the kid week stats response status is 404', () => expect(res.status).toBe(404));
  });

  // ── Week actions ──────────────────────────────────────────────────────────

  Scenario('a kid reads week actions for their own week', ({ When, Then, And }) => {
    When('kid "Iman" GETs /api/kid/weeks/:id/actions for their week', async () => {
      res = await app.request(`/api/kid/weeks/${weekIds.get('Iman')}/actions`, {
        headers: { Authorization: `Bearer ${tokens.get('Iman')}` },
      });
      body = (await res.json()) as Record<string, unknown>;
    });
    Then('the kid week actions response status is 200', () => expect(res.status).toBe(200));
    And('the response contains an actions array', () => {
      expect(Array.isArray(body.actions)).toBe(true);
    });
  });

  Scenario("a kid gets 404 for a sibling's week actions", ({ When, Then }) => {
    When('kid "Iman" requests week actions for Yusuf\'s week', async () => {
      res = await app.request(`/api/kid/weeks/${weekIds.get('Yusuf')}/actions`, {
        headers: { Authorization: `Bearer ${tokens.get('Iman')}` },
      });
    });
    Then('the kid week actions response status is 404', () => expect(res.status).toBe(404));
  });

  // ── Financial savings ─────────────────────────────────────────────────────

  Scenario('a kid reads their savings', ({ When, Then, And }) => {
    When('kid "Iman" GETs /api/kid/financial/savings', async () => {
      res = await app.request('/api/kid/financial/savings', {
        headers: { Authorization: `Bearer ${tokens.get('Iman')}` },
      });
      body = (await res.json()) as Record<string, unknown>;
    });
    Then('the kid savings response status is 200', () => expect(res.status).toBe(200));
    And('the savings body contains savedStickers and currency', () => {
      expect(typeof body.savedStickers).toBe('number');
      expect(typeof body.currency).toBe('string');
      // Iman was seeded with 5 banked stickers.
      expect(body.savedStickers as number).toBe(5);
    });
  });

  // ── Financial investments ──────────────────────────────────────────────────

  Scenario('a kid reads their investments', ({ When, Then, And }) => {
    When('kid "Iman" GETs /api/kid/financial/investments', async () => {
      res = await app.request('/api/kid/financial/investments', {
        headers: { Authorization: `Bearer ${tokens.get('Iman')}` },
      });
      body = (await res.json()) as Record<string, unknown>;
    });
    Then('the kid investments response status is 200', () => expect(res.status).toBe(200));
    And('the investments body contains an investments array', () => {
      expect(Array.isArray(body.investments)).toBe(true);
    });
  });

  // ── Sibling isolation: savings ────────────────────────────────────────────

  Scenario("sibling cannot see Iman's savings", ({ When, Then, And }) => {
    When('kid "Yusuf" GETs /api/kid/financial/savings', async () => {
      res = await app.request('/api/kid/financial/savings', {
        headers: { Authorization: `Bearer ${tokens.get('Yusuf')}` },
      });
      body = (await res.json()) as Record<string, unknown>;
    });
    Then('the kid savings response status is 200', () => expect(res.status).toBe(200));
    And("Yusuf's savedStickers is 0", () => {
      // Yusuf has no mw_savings row — should default to 0, not Iman's 5.
      expect(body.savedStickers as number).toBe(0);
    });
  });
});
