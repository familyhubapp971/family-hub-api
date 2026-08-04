/**
 * Step bindings for kid-world-flags.feature (FHS-373).
 *
 * Kid identity from kid token (no memberId param). Real Postgres on :5433.
 * Mirrors the kid-learn.steps.ts pattern: kidRouter + mintKidToken + no-op
 * pinRequestTenant mock.
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
let res: Response;
let completeRes: Response;

async function mintKidToken(memberId: string, tenantId: string, slug: string): Promise<string> {
  const secret = new TextEncoder().encode(config.KID_AUTH_SECRET);
  return new SignJWT({ tenantId, tenantSlug: slug, scope: 'child' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(memberId)
    .setIssuer(KID_ISSUER)
    .setExpirationTime('1h')
    .sign(secret);
}

const authFor = (name: string) => ({ Authorization: `Bearer ${tokens.get(name)}` });
const jsonAuth = (name: string) => ({ ...authFor(name), 'Content-Type': 'application/json' });

const feature = await loadFeature(
  new URL('../features/kid-world-flags.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    Given('a family with kid "Amira" and sibling "Zayd"', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE world_flags_learn_progress RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE world_flags_progress RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);

      const [t] = await db
        .insert(tenants)
        .values({ slug: `kidflags-${randomUUID().slice(0, 8)}`, name: 'Flags Fam' })
        .returning();
      const [amira] = await db
        .insert(members)
        .values({ tenantId: t!.id, displayName: 'Amira', role: 'child', isChild: true })
        .returning();
      const [zayd] = await db
        .insert(members)
        .values({ tenantId: t!.id, displayName: 'Zayd', role: 'child', isChild: true })
        .returning();

      tokens.set('Amira', await mintKidToken(amira!.id, t!.id, t!.slug));
      tokens.set('Zayd', await mintKidToken(zayd!.id, t!.id, t!.slug));

      app = new Hono();
      app.route('/api/kid', kidRouter);
    });
  });

  // ─── Scenario: explore and read back ────────────────────────────────────────

  Scenario('a kid explores a flag and sees it back', ({ When, Then, And }) => {
    let explored: string[] = [];

    When('"Amira" POSTs /api/kid/world-flags/explore with countryCode "GB"', async () => {
      res = await app.request('/api/kid/world-flags/explore', {
        method: 'POST',
        headers: jsonAuth('Amira'),
        body: JSON.stringify({ countryCode: 'GB' }),
      });
    });
    Then('the kid explore response status is 200', () => expect(res.status).toBe(200));
    And('the kid explore body has explored true', async () => {
      const body = (await res.json()) as { explored: boolean };
      expect(body.explored).toBe(true);
    });
    When('"Amira" GETs /api/kid/world-flags', async () => {
      res = await app.request('/api/kid/world-flags', { headers: authFor('Amira') });
      const body = (await res.json()) as { explored: string[] };
      explored = body.explored ?? [];
    });
    Then('the kid world-flags response status is 200', () => expect(res.status).toBe(200));
    And('the kid explored list contains "GB"', () => expect(explored).toContain('GB'));
  });

  // ─── Scenario: idempotency ───────────────────────────────────────────────────

  Scenario('exploring the same flag twice is idempotent', ({ When, Then, And }) => {
    let explored: string[] = [];

    When('"Amira" POSTs /api/kid/world-flags/explore with countryCode "US"', async () => {
      await app.request('/api/kid/world-flags/explore', {
        method: 'POST',
        headers: jsonAuth('Amira'),
        body: JSON.stringify({ countryCode: 'US' }),
      });
    });
    And('"Amira" POSTs /api/kid/world-flags/explore with countryCode "US"', async () => {
      await app.request('/api/kid/world-flags/explore', {
        method: 'POST',
        headers: jsonAuth('Amira'),
        body: JSON.stringify({ countryCode: 'US' }),
      });
    });
    When('"Amira" GETs /api/kid/world-flags', async () => {
      const r = await app.request('/api/kid/world-flags', { headers: authFor('Amira') });
      const body = (await r.json()) as { explored: string[] };
      explored = body.explored ?? [];
    });
    Then('the kid explored list has {int} code', (_c, n: number) =>
      expect(explored).toHaveLength(n),
    );
  });

  // ─── Scenario: member isolation (explored) ───────────────────────────────────

  Scenario("a kid only sees their own flags: not their sibling's", ({ When, Then }) => {
    let explored: string[] = [];

    When('"Amira" POSTs /api/kid/world-flags/explore with countryCode "JP"', async () => {
      await app.request('/api/kid/world-flags/explore', {
        method: 'POST',
        headers: jsonAuth('Amira'),
        body: JSON.stringify({ countryCode: 'JP' }),
      });
    });
    When('"Zayd" GETs /api/kid/world-flags', async () => {
      const r = await app.request('/api/kid/world-flags', { headers: authFor('Zayd') });
      const body = (await r.json()) as { explored: string[] };
      explored = body.explored ?? [];
    });
    Then('the kid explored list has {int} codes', (_c, n: number) =>
      expect(explored).toHaveLength(n),
    );
  });

  // ─── Scenario: learn-complete and read back ──────────────────────────────────

  Scenario('a kid completes a learn-path set and sees it back', ({ When, Then, And }) => {
    let progress: Record<string, number[]> = {};

    When(
      '"Amira" POSTs /api/kid/world-flags/learn-complete with continent "Africa" chunkIndex 0',
      async () => {
        completeRes = await app.request('/api/kid/world-flags/learn-complete', {
          method: 'POST',
          headers: jsonAuth('Amira'),
          body: JSON.stringify({ continent: 'Africa', chunkIndex: 0 }),
        });
      },
    );
    Then('the kid learn-complete response status is 200', () =>
      expect(completeRes.status).toBe(200),
    );
    And('the kid learn-complete body has completed true', async () => {
      const body = (await completeRes.json()) as { completed: boolean };
      expect(body.completed).toBe(true);
    });
    When('"Amira" GETs /api/kid/world-flags/learn', async () => {
      res = await app.request('/api/kid/world-flags/learn', { headers: authFor('Amira') });
      const body = (await res.json()) as { progress: Record<string, number[]> };
      progress = body.progress ?? {};
    });
    Then('the kid learn response status is 200', () => expect(res.status).toBe(200));
    And('the kid learn progress for "Africa" contains set 0', () =>
      expect(progress['Africa'] ?? []).toContain(0),
    );
  });

  // ─── Scenario: learn-complete idempotency ────────────────────────────────────

  Scenario('completing the same set twice is idempotent', ({ When, Then, And }) => {
    let progress: Record<string, number[]> = {};

    When(
      '"Amira" POSTs /api/kid/world-flags/learn-complete with continent "Europe" chunkIndex 1',
      async () => {
        await app.request('/api/kid/world-flags/learn-complete', {
          method: 'POST',
          headers: jsonAuth('Amira'),
          body: JSON.stringify({ continent: 'Europe', chunkIndex: 1 }),
        });
      },
    );
    And(
      '"Amira" POSTs /api/kid/world-flags/learn-complete with continent "Europe" chunkIndex 1',
      async () => {
        await app.request('/api/kid/world-flags/learn-complete', {
          method: 'POST',
          headers: jsonAuth('Amira'),
          body: JSON.stringify({ continent: 'Europe', chunkIndex: 1 }),
        });
      },
    );
    When('"Amira" GETs /api/kid/world-flags/learn', async () => {
      const r = await app.request('/api/kid/world-flags/learn', { headers: authFor('Amira') });
      const body = (await r.json()) as { progress: Record<string, number[]> };
      progress = body.progress ?? {};
    });
    Then('the kid learn progress for "Europe" has {int} completed set', (_c, n: number) =>
      expect(progress['Europe'] ?? []).toHaveLength(n),
    );
  });

  // ─── Scenario: member isolation (learn) ─────────────────────────────────────

  Scenario("a kid only sees their own learn progress: not their sibling's", ({ When, Then }) => {
    let progress: Record<string, number[]> = {};

    When(
      '"Amira" POSTs /api/kid/world-flags/learn-complete with continent "Asia" chunkIndex 0',
      async () => {
        await app.request('/api/kid/world-flags/learn-complete', {
          method: 'POST',
          headers: jsonAuth('Amira'),
          body: JSON.stringify({ continent: 'Asia', chunkIndex: 0 }),
        });
      },
    );
    When('"Zayd" GETs /api/kid/world-flags/learn', async () => {
      const r = await app.request('/api/kid/world-flags/learn', { headers: authFor('Zayd') });
      const body = (await r.json()) as { progress: Record<string, number[]> };
      progress = body.progress ?? {};
    });
    Then('the kid learn progress is empty', () => expect(Object.keys(progress)).toHaveLength(0));
  });
});
