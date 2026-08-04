/**
 * Step bindings for invitations-claim.feature (FHS-354).
 *
 * Drives the claim flow against real Postgres, exercising the real
 * app_claimable_invitations SECURITY DEFINER function (migration 0030): a
 * seatless pending invite is found by email, the seat is created, and the
 * invitation flips to accepted.
 */

import { randomUUID } from 'node:crypto';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono, type MiddlewareHandler } from 'hono';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
  pinRequestTenant: async () => {},
}));

import { invitationClaimRouter } from '../../../apps/api/src/routes/invitations.js';
import { tenants, members, users, pendingInvitations } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';

let db: Database;
let app: Hono;
let userId: string;
let email: string;
let tenantId: string;
let res: Response;

async function seed(): Promise<void> {
  db = getTestDb() as unknown as Database;
  await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM users`);
  userId = randomUUID();
  email = `invited-${userId.slice(0, 8)}@example.com`;
  await db.insert(users).values({ id: userId, email });
  const [t] = await db
    .insert(tenants)
    .values({ slug: `claimfam-${randomUUID().slice(0, 8)}`, name: 'Claim Fam' })
    .returning();
  tenantId = t!.id;
  const [admin] = await db
    .insert(members)
    .values({ tenantId, displayName: 'Admin', role: 'admin' })
    .returning();
  // Seatless pending invite (member_id null): claim creates the seat.
  await db.insert(pendingInvitations).values({
    tenantId,
    email,
    role: 'adult',
    invitedBy: admin!.id,
    status: 'pending',
  });

  const seedAuth: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: userId, email, claims: {} } as never);
    c.set('userRow', { id: userId, email, createdAt: new Date(), updatedAt: new Date() } as never);
    await next();
  };
  app = new Hono();
  app.use('*', seedAuth);
  app.route('/api/invitations/claim', invitationClaimRouter);
}

const feature = await loadFeature(
  new URL('../features/invitations-claim.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    Given('a user with a seatless pending invite to a family', seed);
  });

  Scenario('claiming creates the seat and accepts the invite', ({ When, Then, And }) => {
    let body: { claimed: Array<{ tenantId: string; slug: string }> };
    When('the user POSTs to claim their invites', async () => {
      res = await app.request('/api/invitations/claim', { method: 'POST' });
      body = (await res.json()) as { claimed: Array<{ tenantId: string; slug: string }> };
    });
    Then('the claim status is 200', () => {
      expect(res.status).toBe(200);
    });
    And('the claimed list includes their family', () => {
      expect(body.claimed.map((c) => c.tenantId)).toContain(tenantId);
    });
    And('a member seat now exists for the user', async () => {
      const { rows } = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from members where tenant_id = ${tenantId} and user_id = ${userId}`,
      );
      expect(rows[0]?.n).toBe(1);
    });
    And('the invitation is accepted', async () => {
      const { rows } = await db.execute<{ status: string }>(
        sql`select status from pending_invitations where tenant_id = ${tenantId} and lower(email) = lower(${email})`,
      );
      expect(rows[0]?.status).toBe('accepted');
    });
  });
});
