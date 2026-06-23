/**
 * Step bindings for kid-habits.feature (FHS-374).
 *
 * The kid reads their OWN weekly habits (read-only since FHS-374 — sticker
 * writes were removed). Real kid token against real Postgres.
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
let imanWeekId: string;
let yusufWeekId: string;
let res: Response;

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
  new URL('../features/kid-habits.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    Given(
      'a family with kid "Iman" (habit "Read a book") and sibling "Yusuf" (habit "Tidy room")',
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
        await db
          .insert(habits)
          .values({ tenantId: t!.id, memberId: iman!.id, name: 'Read a book' });
        await db.insert(habits).values({ tenantId: t!.id, memberId: yusuf!.id, name: 'Tidy room' });
        const [iw] = await db
          .insert(mwWeeks)
          .values({
            tenantId: t!.id,
            memberId: iman!.id,
            weekNumber: 10,
            year: 2026,
            startDate: '2026-03-02',
          })
          .returning();
        const [yw] = await db
          .insert(mwWeeks)
          .values({
            tenantId: t!.id,
            memberId: yusuf!.id,
            weekNumber: 10,
            year: 2026,
            startDate: '2026-03-02',
          })
          .returning();
        imanWeekId = iw!.id;
        yusufWeekId = yw!.id;
        kidToken = await mintKidToken(iman!.id, t!.id, t!.slug);
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

  Scenario('a kid can request habits for a specific past week by weekId', ({ When, Then }) => {
    When('the kid GETs /api/kid/habits with a valid weekId', async () => {
      res = await app.request(`/api/kid/habits?weekId=${imanWeekId}`, {
        headers: { Authorization: `Bearer ${kidToken}` },
      });
    });
    Then('the kid habits response status is 200', () => {
      expect(res.status).toBe(200);
    });
  });

  Scenario('a kid gets 404 for a weekId that belongs to a sibling', ({ When, Then }) => {
    When("the kid requests habits for a sibling's weekId", async () => {
      res = await app.request(`/api/kid/habits?weekId=${yusufWeekId}`, {
        headers: { Authorization: `Bearer ${kidToken}` },
      });
    });
    Then('the kid habits response status is 404', () => {
      expect(res.status).toBe(404);
    });
  });
});
