/**
 * Step bindings for kid-journal.feature (FHS-366).
 *
 * The kid writes + reads their OWN journal (token-scoped); a sibling never sees
 * it. Real kid token against real Postgres.
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
import { tenants, members } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';

const KID_ISSUER = 'family-hub-kid-auth';

let db: Database;
let app: Hono;
const tokens = new Map<string, string>();
let saveRes: Response;
let readRes: Response;

async function mintKidToken(memberId: string, tenantId: string, slug: string): Promise<string> {
  const secret = new TextEncoder().encode(config.KID_AUTH_SECRET);
  return new SignJWT({ tenantId, tenantSlug: slug, scope: 'child' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(memberId)
    .setIssuer(KID_ISSUER)
    .setExpirationTime('1h')
    .sign(secret);
}

const today = new Date().toISOString().slice(0, 10);

const feature = await loadFeature(
  new URL('../features/kid-journal.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    Given('a family with kid "Iman" and sibling "Yusuf"', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      const [t] = await db
        .insert(tenants)
        .values({ slug: `kidjournal-${randomUUID().slice(0, 8)}`, name: 'Journal Fam' })
        .returning();
      const [iman] = await db
        .insert(members)
        .values({ tenantId: t!.id, displayName: 'Iman', role: 'child', isChild: true })
        .returning();
      const [yusuf] = await db
        .insert(members)
        .values({ tenantId: t!.id, displayName: 'Yusuf', role: 'child', isChild: true })
        .returning();
      tokens.set('Iman', await mintKidToken(iman!.id, t!.id, t!.slug));
      tokens.set('Yusuf', await mintKidToken(yusuf!.id, t!.id, t!.slug));
      app = new Hono();
      app.route('/api/kid', kidRouter);
    });
  });

  const save = (name: string, body: string) =>
    app.request('/api/kid/journal', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokens.get(name)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryDate: today, mood: 'happy', body }),
    });
  const readDay = (name: string, date: string) =>
    app.request(`/api/kid/journal?date=${encodeURIComponent(date)}`, {
      headers: { Authorization: `Bearer ${tokens.get(name)}` },
    });

  Scenario('a kid saves and reads back their journal', ({ When, Then, And }) => {
    When('the kid "Iman" saves a journal entry for today with body "Great day"', async () => {
      saveRes = await save('Iman', 'Great day');
    });
    Then('the journal save status is 200', () => {
      expect(saveRes.status).toBe(200);
    });
    And('reading "Iman" journal for today shows body "Great day"', async () => {
      const r = await readDay('Iman', today);
      const b = (await r.json()) as { entry: { body: string } | null };
      expect(b.entry?.body).toBe('Great day');
    });
  });

  Scenario("a sibling does not see another kid's journal", ({ When, Then }) => {
    When('the kid "Iman" saves a journal entry for today with body "Great day"', async () => {
      saveRes = await save('Iman', 'Great day');
    });
    Then('reading "Yusuf" journal for today shows no entry', async () => {
      const r = await readDay('Yusuf', today);
      const b = (await r.json()) as { entry: unknown };
      expect(b.entry).toBeNull();
    });
  });

  Scenario('an invalid journal date is rejected', ({ When, Then }) => {
    When('the kid "Iman" reads their journal for date "not-a-date"', async () => {
      readRes = await readDay('Iman', 'not-a-date');
    });
    Then('the journal read status is 400', () => {
      expect(readRes.status).toBe(400);
    });
  });
});
