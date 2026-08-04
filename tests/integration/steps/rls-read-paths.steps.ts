/**
 * Step bindings for rls-read-paths.feature (FHS-354).
 *
 * Proves the SECURITY DEFINER readers return the legitimately cross-tenant rows
 * when called AS the limited app_runtime role: while a plain members read as
 * app_runtime (no tenant pinned) returns nothing, confirming the function is
 * what makes the cross-tenant lookup possible under RLS.
 */

import { randomUUID } from 'node:crypto';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { getTestDb, runtimeTestPool } from '@familyhub/test-utils';
import { tenants, members, users, pendingInvitations } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';

let db: Database;
let userId: string;
let email: string;

async function seed(): Promise<void> {
  db = getTestDb() as unknown as Database;
  await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM users`);
  userId = randomUUID();
  email = `multi-${userId.slice(0, 8)}@example.com`;
  await db.insert(users).values({ id: userId, email });
  for (const slug of ['fam-a', 'fam-b']) {
    const [t] = await db
      .insert(tenants)
      .values({ slug: `${slug}-${randomUUID().slice(0, 8)}`, name: slug })
      .returning();
    // The user themselves (so app_user_memberships finds both families).
    await db.insert(members).values({ tenantId: t!.id, userId, displayName: 'Me', role: 'adult' });
    // An inviter member + a pending invite to `email` (so app_claimable finds both).
    const [inviter] = await db
      .insert(members)
      .values({ tenantId: t!.id, displayName: 'Admin', role: 'admin' })
      .returning();
    await db.insert(pendingInvitations).values({
      tenantId: t!.id,
      email,
      role: 'adult',
      invitedBy: inviter!.id,
      status: 'pending',
    });
  }
}

const feature = await loadFeature(
  new URL('../features/rls-read-paths.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    Given('a user belongs to two families and has a pending invite in each', seed);
  });

  Scenario('app_runtime reads a user memberships across families', ({ When, Then, And }) => {
    let memberships = 0;
    let plainCount = 0;
    When('app_runtime calls app_user_memberships for that user', async () => {
      const c = await runtimeTestPool().connect();
      try {
        const r = await c.query('SELECT * FROM app_user_memberships($1)', [userId]);
        memberships = r.rows.length;
        // Contrast: a plain members read as app_runtime with no tenant pinned.
        const r2 = await c.query('SELECT id FROM members WHERE user_id = $1', [userId]);
        plainCount = r2.rows.length;
      } finally {
        c.release();
      }
    });
    Then('it returns both families', () => {
      expect(memberships).toBe(2);
    });
    And('a plain members read as app_runtime returns nothing', () => {
      expect(plainCount).toBe(0);
    });
  });

  Scenario('app_runtime reads claimable invitations by email across families', ({ When, Then }) => {
    let invites = 0;
    When('app_runtime calls app_claimable_invitations for that email', async () => {
      const c = await runtimeTestPool().connect();
      try {
        const r = await c.query('SELECT * FROM app_claimable_invitations($1)', [email]);
        invites = r.rows.length;
      } finally {
        c.release();
      }
    });
    Then('it returns both invites', () => {
      expect(invites).toBe(2);
    });
  });
});
