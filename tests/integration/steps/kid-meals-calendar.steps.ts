/**
 * Step bindings for kid-meals-calendar.feature (FHS-365).
 *
 * The kid reads the family meal plan + schedule scoped to themselves +
 * family-wide entries, never a sibling's. Real kid token against real Postgres.
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
import { tenants, members, mealTemplates, events } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';

const KID_ISSUER = 'family-hub-kid-auth';

let db: Database;
let app: Hono;
let kidToken: string;
let res: Response;
let names: string[] = [];

async function mintKidToken(memberId: string, tenantId: string, slug: string): Promise<string> {
  const secret = new TextEncoder().encode(config.KID_AUTH_SECRET);
  return new SignJWT({ tenantId, tenantSlug: slug, scope: 'child' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(memberId)
    .setIssuer(KID_ISSUER)
    .setExpirationTime('1h')
    .sign(secret);
}

function mondayIso(): string {
  const d = new Date();
  const off = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - off))
    .toISOString()
    .slice(0, 10);
}

const feature = await loadFeature(
  new URL('../features/kid-meals-calendar.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    Given(
      'a family with kid "Iman", sibling "Yusuf", family + per-kid meals, and family + per-kid events this week',
      async () => {
        db = getTestDb() as unknown as Database;
        await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
        const [t] = await db
          .insert(tenants)
          .values({ slug: `kidmeals-${randomUUID().slice(0, 8)}`, name: 'Meal Fam' })
          .returning();
        const [iman] = await db
          .insert(members)
          .values({ tenantId: t!.id, displayName: 'Iman', role: 'child', isChild: true })
          .returning();
        const [yusuf] = await db
          .insert(members)
          .values({ tenantId: t!.id, displayName: 'Yusuf', role: 'child', isChild: true })
          .returning();
        await db.insert(mealTemplates).values([
          { tenantId: t!.id, dayOfWeek: 'mon', slot: 'lunch', name: 'Pasta', memberId: null },
          {
            tenantId: t!.id,
            dayOfWeek: 'mon',
            slot: 'snack',
            name: 'Iman Snack',
            memberId: iman!.id,
          },
          {
            tenantId: t!.id,
            dayOfWeek: 'mon',
            slot: 'lunch',
            name: 'Yusuf Lunch',
            memberId: yusuf!.id,
          },
        ]);
        const day = mondayIso();
        await db.insert(events).values([
          { tenantId: t!.id, date: day, title: 'Family Movie', type: 'home', memberId: null },
          {
            tenantId: t!.id,
            date: day,
            title: 'Iman Football',
            type: 'school',
            memberId: iman!.id,
          },
          { tenantId: t!.id, date: day, title: 'Yusuf Dentist', type: 'home', memberId: yusuf!.id },
        ]);
        kidToken = await mintKidToken(iman!.id, t!.id, t!.slug);
        app = new Hono();
        app.route('/api/kid', kidRouter);
      },
    );
  });

  Scenario("a kid sees their own + family meals, not a sibling's", ({ When, Then, And }) => {
    When('the kid GETs /api/kid/meals', async () => {
      res = await app.request('/api/kid/meals', {
        headers: { Authorization: `Bearer ${kidToken}` },
      });
      const body = (await res.json()) as { meals: Array<{ name: string }> };
      names = body.meals.map((m) => m.name);
    });
    Then('the kid meals response status is 200', () => {
      expect(res.status).toBe(200);
    });
    And('the kid meals include "Pasta"', () => {
      expect(names).toContain('Pasta');
    });
    And('the kid meals include "Iman Snack"', () => {
      expect(names).toContain('Iman Snack');
    });
    And('the kid meals do not include "Yusuf Lunch"', () => {
      expect(names).not.toContain('Yusuf Lunch');
    });
  });

  Scenario("a kid sees their own + family events, not a sibling's", ({ When, Then, And }) => {
    When('the kid GETs /api/kid/events', async () => {
      res = await app.request('/api/kid/events', {
        headers: { Authorization: `Bearer ${kidToken}` },
      });
      const body = (await res.json()) as { events: Array<{ title: string }> };
      names = body.events.map((e) => e.title);
    });
    Then('the kid events response status is 200', () => {
      expect(res.status).toBe(200);
    });
    And('the kid events include "Family Movie"', () => {
      expect(names).toContain('Family Movie');
    });
    And('the kid events include "Iman Football"', () => {
      expect(names).toContain('Iman Football');
    });
    And('the kid events do not include "Yusuf Dentist"', () => {
      expect(names).not.toContain('Yusuf Dentist');
    });
  });

  Scenario('an invalid weekStart is rejected', ({ When, Then }) => {
    When('the kid GETs /api/kid/events with weekStart "not-a-date"', async () => {
      res = await app.request('/api/kid/events?weekStart=not-a-date', {
        headers: { Authorization: `Bearer ${kidToken}` },
      });
    });
    Then('the kid events response status is 400', () => {
      expect(res.status).toBe(400);
    });
  });
});
