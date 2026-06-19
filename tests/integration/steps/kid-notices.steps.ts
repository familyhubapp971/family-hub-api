/**
 * Step bindings for kid-notices.feature (FHS-355).
 *
 * Proves the first kid-scoped data feed: a logged-in kid sees their own
 * family's noticeboard, and only theirs. Mints a real kid HS256 token and
 * drives the kidRouter against real Postgres.
 */

import { randomUUID } from 'node:crypto';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { getTestDb } from '../support/db.js';

// The kid router calls getDb() (the app pool) — point it at the test DB so the
// handler reads the same Postgres the Background seeds. Mirrors the pattern in
// invitations.steps.ts.
vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
  // FHS-354 — pin is a no-op here (tests run as the superuser, which bypasses RLS).
  pinRequestTenant: async () => {},
}));
import { config } from '../../../apps/api/src/config.js';
import { kidRouter } from '../../../apps/api/src/routes/kid.js';
import { tenants, members, notices } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';

const KID_ISSUER = 'family-hub-kid-auth';

let db: Database;
let app: Hono;
let kidToken: string;
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
  new URL('../features/kid-notices.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    Given('a family "kidfam" with a kid and a notice "Tidy your room"', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      const [t] = await db
        .insert(tenants)
        .values({ slug: `kidfam-${randomUUID().slice(0, 8)}`, name: 'Kid Fam' })
        .returning();
      const [kid] = await db
        .insert(members)
        .values({ tenantId: t!.id, displayName: 'Iman', role: 'child', isChild: true })
        .returning();
      await db.insert(notices).values({ tenantId: t!.id, body: 'Tidy your room' });
      kidToken = await mintKidToken(kid!.id, t!.id, t!.slug);
      app = new Hono();
      app.route('/api/kid', kidRouter);
    });
  });

  Scenario('a kid sees their own family notices', ({ When, Then, And }) => {
    When('the kid GETs /api/kid/notices with their token', async () => {
      res = await app.request('/api/kid/notices', {
        headers: { Authorization: `Bearer ${kidToken}` },
      });
    });
    Then('the kid notices response status is 200', () => {
      expect(res.status).toBe(200);
    });
    And('the kid notices include "Tidy your room"', async () => {
      const body = (await res.json()) as { notices: Array<{ body: string }> };
      expect(body.notices.map((n) => n.body)).toContain('Tidy your room');
    });
  });

  Scenario('a kid never sees another family notices', ({ Given, When, Then }) => {
    Given('another family "otherfam" has a notice "Secret stuff"', async () => {
      const [other] = await db
        .insert(tenants)
        .values({ slug: `otherfam-${randomUUID().slice(0, 8)}`, name: 'Other Fam' })
        .returning();
      await db.insert(notices).values({ tenantId: other!.id, body: 'Secret stuff' });
    });
    When('the kid GETs /api/kid/notices with their token', async () => {
      res = await app.request('/api/kid/notices', {
        headers: { Authorization: `Bearer ${kidToken}` },
      });
    });
    Then('the kid notices do not include "Secret stuff"', async () => {
      const body = (await res.json()) as { notices: Array<{ body: string }> };
      expect(body.notices.map((n) => n.body)).not.toContain('Secret stuff');
    });
  });
});
