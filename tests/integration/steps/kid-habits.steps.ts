/**
 * Step bindings for kid-habits.feature (FHS-363).
 *
 * The kid's interactive weekly habits: read own habits + this week's stickers,
 * place a sticker on today only (server blocks past/finalized for a kid). Real
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
import { tenants, members, habits, mwWeeks } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';

const KID_ISSUER = 'family-hub-kid-auth';

let db: Database;
let app: Hono;
let kidToken: string;
let yusufToken: string;
let imanHabitId: string;
let finalizedWeekId: string;
let res: Response;
let placeRes: Response;
let removeRes: Response;

async function mintKidToken(memberId: string, tenantId: string, slug: string): Promise<string> {
  const secret = new TextEncoder().encode(config.KID_AUTH_SECRET);
  return new SignJWT({ tenantId, tenantSlug: slug, scope: 'child' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(memberId)
    .setIssuer(KID_ISSUER)
    .setExpirationTime('1h')
    .sign(secret);
}

function todayIndex(startDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`);
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((todayUtc - start.getTime()) / 86_400_000);
}

const feature = await loadFeature(
  new URL('../features/kid-habits.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    Given(
      'a family with kid "Iman" (habit "Read a book"), sibling "Yusuf" (habit "Tidy room"), and a finalized past week for Iman',
      async () => {
        db = getTestDb() as unknown as Database;
        await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
        const [t] = await db
          .insert(tenants)
          .values({
            slug: `kidhabits-${randomUUID().slice(0, 8)}`,
            name: 'Habit Fam',
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
        await db.insert(habits).values({ tenantId: t!.id, memberId: yusuf!.id, name: 'Tidy room' });
        imanHabitId = imanHabit!.id;
        const [fw] = await db
          .insert(mwWeeks)
          .values({
            tenantId: t!.id,
            memberId: iman!.id,
            weekNumber: 2,
            year: 2026,
            startDate: '2026-01-05',
            isFinalized: true,
          })
          .returning();
        finalizedWeekId = fw!.id;
        kidToken = await mintKidToken(iman!.id, t!.id, t!.slug);
        yusufToken = await mintKidToken(yusuf!.id, t!.id, t!.slug);
        app = new Hono();
        app.route('/api/kid', kidRouter);
      },
    );
  });

  Scenario('a kid reads only their own habits for the current week', ({ When, Then, And }) => {
    let names: string[] = [];
    When('the kid GETs /api/kid/habits with their token', async () => {
      res = await app.request('/api/kid/habits', {
        headers: { Authorization: `Bearer ${kidToken}` },
      });
      const body = (await res.json()) as { habits: Array<{ name: string }> };
      names = body.habits.map((h) => h.name);
    });
    Then('the kid habits response status is 200', () => {
      expect(res.status).toBe(200);
    });
    And('the kid habits include "Read a book"', () => {
      expect(names).toContain('Read a book');
    });
    And('the kid habits do not include "Tidy room"', () => {
      expect(names).not.toContain('Tidy room');
    });
  });

  Scenario('a kid places a sticker on today', ({ When, Then, And }) => {
    When('the kid places a "gold-star" sticker on today', async () => {
      const get = await app.request('/api/kid/habits', {
        headers: { Authorization: `Bearer ${kidToken}` },
      });
      const body = (await get.json()) as {
        habits: Array<{ id: string }>;
        week: { id: string; startDate: string };
      };
      const habitId = body.habits[0]!.id;
      placeRes = await app.request(`/api/kid/habits/${habitId}/stickers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kidToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          weekId: body.week.id,
          day: todayIndex(body.week.startDate),
          sticker: 'gold-star',
        }),
      });
    });
    Then('the place-sticker response status is 200', () => {
      expect(placeRes.status).toBe(200);
    });
    And('the kid habits then show a sticker today', async () => {
      const get = await app.request('/api/kid/habits', {
        headers: { Authorization: `Bearer ${kidToken}` },
      });
      const body = (await get.json()) as {
        stickers: Array<{ day: number }>;
        week: { startDate: string };
      };
      expect(body.stickers.map((s) => s.day)).toContain(todayIndex(body.week.startDate));
    });
  });

  Scenario('a kid cannot sticker a finalized week', ({ When, Then }) => {
    When('the kid places a "heart" sticker on day 0 of the finalized week', async () => {
      const get = await app.request('/api/kid/habits', {
        headers: { Authorization: `Bearer ${kidToken}` },
      });
      const body = (await get.json()) as { habits: Array<{ id: string }> };
      const habitId = body.habits[0]!.id;
      placeRes = await app.request(`/api/kid/habits/${habitId}/stickers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kidToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekId: finalizedWeekId, day: 0, sticker: 'heart' }),
      });
    });
    Then('the place-sticker response status is 403', () => {
      expect(placeRes.status).toBe(403);
    });
  });

  Scenario("a kid cannot place a sticker on a sibling's habit", ({ When, Then }) => {
    When('sibling "Yusuf" tries to sticker Iman\'s habit today', async () => {
      const get = await app.request('/api/kid/habits', {
        headers: { Authorization: `Bearer ${yusufToken}` },
      });
      const body = (await get.json()) as { week: { id: string; startDate: string } };
      placeRes = await app.request(`/api/kid/habits/${imanHabitId}/stickers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${yusufToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          weekId: body.week.id,
          day: todayIndex(body.week.startDate),
          sticker: 'gold-star',
        }),
      });
    });
    Then('the place-sticker response status is 404', () => {
      expect(placeRes.status).toBe(404);
    });
  });

  Scenario("a kid removes today's sticker", ({ When, Then, And }) => {
    When('the kid places then removes a sticker on today', async () => {
      const get = await app.request('/api/kid/habits', {
        headers: { Authorization: `Bearer ${kidToken}` },
      });
      const body = (await get.json()) as {
        habits: Array<{ id: string }>;
        week: { id: string; startDate: string };
      };
      const habitId = body.habits[0]!.id;
      const day = todayIndex(body.week.startDate);
      await app.request(`/api/kid/habits/${habitId}/stickers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kidToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekId: body.week.id, day, sticker: 'gold-star' }),
      });
      removeRes = await app.request(`/api/kid/habits/${habitId}/stickers`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${kidToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekId: body.week.id, day }),
      });
    });
    Then('the remove-sticker response status is 204', () => {
      expect(removeRes.status).toBe(204);
    });
    And('the kid habits then show no sticker today', async () => {
      const get = await app.request('/api/kid/habits', {
        headers: { Authorization: `Bearer ${kidToken}` },
      });
      const body = (await get.json()) as {
        stickers: Array<{ day: number }>;
        week: { startDate: string };
      };
      expect(body.stickers.map((s) => s.day)).not.toContain(todayIndex(body.week.startDate));
    });
  });
});
