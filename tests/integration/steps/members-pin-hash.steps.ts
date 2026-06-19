import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { sql, eq } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { tenants, members } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
  pinRequestTenant: async () => {},
}));

const feature = await loadFeature(
  new URL('../features/members-pin-hash.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  const tenantIds: Record<string, string> = {};
  const memberIds: Record<string, string> = {};

  Background(({ Given }) => {
    Given('the test Postgres has clean tenants and members tables', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      for (const k of Object.keys(tenantIds)) delete tenantIds[k];
      for (const k of Object.keys(memberIds)) delete memberIds[k];
    });
  });

  Scenario(
    'A kid member can be inserted with pin_hash + is_child=true',
    ({ Given, When, Then, And }) => {
      Given('a tenant {string} exists', async (_ctx, slug: string) => {
        const [t] = await db
          .insert(tenants)
          .values({ slug, name: `${slug} Family` })
          .returning();
        tenantIds[slug] = t!.id;
      });

      When(
        'a kid member {string} is inserted with pin_hash {string} and is_child true',
        async (_ctx, name: string, hash: string) => {
          const [m] = await db
            .insert(members)
            .values({
              tenantId: tenantIds['khan']!,
              displayName: name,
              role: 'child',
              pinHash: hash,
              isChild: true,
            })
            .returning();
          memberIds[name] = m!.id;
        },
      );

      Then('the row reads back with is_child true', async () => {
        const [row] = await db
          .select({ isChild: members.isChild })
          .from(members)
          .where(eq(members.id, memberIds['Iman']!));
        expect(row?.isChild).toBe(true);
      });

      And('the row reads back with the same pin_hash', async () => {
        const [row] = await db
          .select({ pinHash: members.pinHash })
          .from(members)
          .where(eq(members.id, memberIds['Iman']!));
        expect(row?.pinHash).toBe('$2b$10$dummyhash');
      });
    },
  );

  Scenario(
    'An adult member defaults is_child to false and pin_hash to null',
    ({ Given, When, Then, And }) => {
      Given('a tenant {string} exists', async (_ctx, slug: string) => {
        const [t] = await db
          .insert(tenants)
          .values({ slug, name: `${slug} Family` })
          .returning();
        tenantIds[slug] = t!.id;
      });

      When(
        'an adult member {string} is inserted with no pin_hash and no is_child',
        async (_ctx, name: string) => {
          const [m] = await db
            .insert(members)
            .values({ tenantId: tenantIds['khan']!, displayName: name, role: 'adult' })
            .returning();
          memberIds[name] = m!.id;
        },
      );

      Then('the row reads back with is_child false', async () => {
        const [row] = await db
          .select({ isChild: members.isChild })
          .from(members)
          .where(eq(members.id, memberIds['Sarah']!));
        expect(row?.isChild).toBe(false);
      });

      And('the row reads back with pin_hash null', async () => {
        const [row] = await db
          .select({ pinHash: members.pinHash })
          .from(members)
          .where(eq(members.id, memberIds['Sarah']!));
        expect(row?.pinHash).toBeNull();
      });
    },
  );
});
