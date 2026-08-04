/**
 * Step bindings for kid-tasks.feature (FHS-355).
 *
 * A logged-in kid sees + ticks only their OWN tasks. Mints a real kid token and
 * drives the kidRouter against real Postgres, including the member guard (a kid
 * can't tick another member's task → 404).
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
import { tenants, members, tasks } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';

const KID_ISSUER = 'family-hub-kid-auth';

let db: Database;
let app: Hono;
let kidToken: string;
let kidTaskId: string;
let adultTaskId: string;
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
  new URL('../features/kid-tasks.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    Given('a family with kid task "Brush teeth" and a grown-up task "Pay bills"', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      const [t] = await db
        .insert(tenants)
        .values({ slug: `taskfam-${randomUUID().slice(0, 8)}`, name: 'Task Fam' })
        .returning();
      const [kid] = await db
        .insert(members)
        .values({ tenantId: t!.id, displayName: 'Iman', role: 'child', isChild: true })
        .returning();
      const [adult] = await db
        .insert(members)
        .values({ tenantId: t!.id, displayName: 'Dad', role: 'adult' })
        .returning();
      const [kidTask] = await db
        .insert(tasks)
        .values({ tenantId: t!.id, memberId: kid!.id, title: 'Brush teeth' })
        .returning();
      const [adultTask] = await db
        .insert(tasks)
        .values({ tenantId: t!.id, memberId: adult!.id, title: 'Pay bills' })
        .returning();
      kidTaskId = kidTask!.id;
      adultTaskId = adultTask!.id;
      kidToken = await mintKidToken(kid!.id, t!.id, t!.slug);
      app = new Hono();
      app.route('/api/kid', kidRouter);
    });
  });

  const auth = () => ({ Authorization: `Bearer ${kidToken}` });
  const jsonAuth = () => ({
    Authorization: `Bearer ${kidToken}`,
    'Content-Type': 'application/json',
  });

  Scenario('a kid sees only their own tasks', ({ When, Then, And }) => {
    let bodyTitles: string[] = [];
    When('the kid GETs /api/kid/tasks with their token', async () => {
      res = await app.request('/api/kid/tasks', { headers: auth() });
      const body = (await res.json()) as { tasks: Array<{ title: string }> };
      bodyTitles = body.tasks.map((t) => t.title);
    });
    Then('the kid tasks response status is 200', () => {
      expect(res.status).toBe(200);
    });
    And('the kid tasks include "Brush teeth"', () => {
      expect(bodyTitles).toContain('Brush teeth');
    });
    And('the kid tasks do not include "Pay bills"', () => {
      expect(bodyTitles).not.toContain('Pay bills');
    });
  });

  Scenario('a kid can tick their own task', ({ When, Then, And }) => {
    When('the kid ticks their own task', async () => {
      res = await app.request(`/api/kid/tasks/${kidTaskId}`, {
        method: 'PATCH',
        headers: jsonAuth(),
        body: JSON.stringify({ done: true }),
      });
    });
    Then('the tick response status is 200', () => {
      expect(res.status).toBe(200);
    });
    And('that task is marked done', async () => {
      const { rows } = await db.execute<{ done_at: string | null }>(
        sql`select done_at from tasks where id = ${kidTaskId}`,
      );
      expect(rows[0]?.done_at).not.toBeNull();
    });
  });

  Scenario('a kid cannot tick another members task', ({ When, Then }) => {
    When('the kid tries to tick the grown-up task', async () => {
      res = await app.request(`/api/kid/tasks/${adultTaskId}`, {
        method: 'PATCH',
        headers: jsonAuth(),
        body: JSON.stringify({ done: true }),
      });
    });
    Then('the tick response status is 404', () => {
      expect(res.status).toBe(404);
    });
  });
});
