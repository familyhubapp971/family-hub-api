/**
 * Step bindings for kid-today.feature (FHS-355).
 *
 * A logged-in kid's Today shows their OWN active habits — never another
 * member's, never archived ones. Real kid token against real Postgres.
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
  // FHS-354 — pin is a no-op here (tests run as the superuser, which bypasses RLS).
  pinRequestTenant: async () => {},
}));

import { config } from '../../../apps/api/src/config.js';
import { kidRouter } from '../../../apps/api/src/routes/kid.js';
import { tenants, members, habits } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';

const KID_ISSUER = 'family-hub-kid-auth';

let db: Database;
let app: Hono;
let kidToken: string;
let res: Response;
let titles: string[] = [];

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
  new URL('../features/kid-today.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    Given(
      'a family with kid habit "Read a book", a grown-up habit "Exercise", and an archived kid habit "Old habit"',
      async () => {
        db = getTestDb() as unknown as Database;
        await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
        const [t] = await db
          .insert(tenants)
          .values({ slug: `habitfam-${randomUUID().slice(0, 8)}`, name: 'Habit Fam' })
          .returning();
        const [kid] = await db
          .insert(members)
          .values({ tenantId: t!.id, displayName: 'Iman', role: 'child', isChild: true })
          .returning();
        const [adult] = await db
          .insert(members)
          .values({ tenantId: t!.id, displayName: 'Dad', role: 'adult' })
          .returning();
        await db.insert(habits).values([
          { tenantId: t!.id, memberId: kid!.id, name: 'Read a book' },
          { tenantId: t!.id, memberId: adult!.id, name: 'Exercise' },
          { tenantId: t!.id, memberId: kid!.id, name: 'Old habit', archivedAt: new Date() },
        ]);
        kidToken = await mintKidToken(kid!.id, t!.id, t!.slug);
        app = new Hono();
        app.route('/api/kid', kidRouter);
      },
    );
  });

  Scenario('a kid sees only their own active habits', ({ When, Then, And }) => {
    When('the kid GETs /api/kid/today with their token', async () => {
      res = await app.request('/api/kid/today', {
        headers: { Authorization: `Bearer ${kidToken}` },
      });
      const body = (await res.json()) as { habits: Array<{ name: string }> };
      titles = body.habits.map((h) => h.name);
    });
    Then('the kid today response status is 200', () => {
      expect(res.status).toBe(200);
    });
    And('the kid habits include "Read a book"', () => {
      expect(titles).toContain('Read a book');
    });
    And('the kid habits do not include "Exercise"', () => {
      expect(titles).not.toContain('Exercise');
    });
    And('the kid habits do not include "Old habit"', () => {
      expect(titles).not.toContain('Old habit');
    });
  });
});
