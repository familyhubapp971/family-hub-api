/**
 * Step bindings for users-rls.feature (FHS-349).
 *
 * Proves the global `users` table's self-scoped RLS policy by connecting AS the
 * limited app_runtime role: only the pinned user's row is visible, nothing is
 * visible with no user pinned, and the user-mirror upsert still works under the
 * role because it pins app.current_user transaction-locally first. Also checks
 * app_runtime has the grants it needs on the global users + tenants tables.
 */

import { randomUUID } from 'node:crypto';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { asRuntimeUser, getTestDb, runtimeTestDb } from '@familyhub/test-utils';
import { getOrCreateUser } from '../../../apps/api/src/lib/user-mirror.js';
import { users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';

let db: Database;
let userU: string;
let userV: string;

async function seedTwoUsers(): Promise<void> {
  db = getTestDb() as unknown as Database;
  // Owner (superuser) bypasses RLS, so it can seed both users.
  userU = randomUUID();
  userV = randomUUID();
  await db
    .insert(users)
    .values([
      { id: userU, email: `u-${userU.slice(0, 8)}@example.com` },
      { id: userV, email: `v-${userV.slice(0, 8)}@example.com` },
    ])
    .onConflictDoNothing();
}

const feature = await loadFeature(
  new URL('../features/users-rls.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Scenario }) => {
  Scenario('the limited role sees only its own user row', ({ Given, When, Then }) => {
    let seen: Array<{ id: string }> = [];
    Given('two users "U" and "V" exist, seeded as the owner', seedTwoUsers);
    When('app_runtime pinned to user "U" selects all users with no filter', async () => {
      seen = await asRuntimeUser(userU, async (c) => {
        const res = await c.query<{ id: string }>('SELECT id FROM users');
        return res.rows;
      });
    });
    Then('it sees only user "U"', () => {
      expect(seen).toHaveLength(1);
      expect(seen[0]?.id).toBe(userU);
    });
  });

  Scenario('the limited role with no user pinned sees nothing', ({ Given, When, Then }) => {
    let count = -1;
    Given('two users "U" and "V" exist, seeded as the owner', seedTwoUsers);
    When('app_runtime with no user pinned selects all users', async () => {
      count = await asRuntimeUser(null, async (c) => {
        const res = await c.query('SELECT id FROM users');
        return res.rows.length;
      });
    });
    Then('it sees zero rows', () => {
      expect(count).toBe(0);
    });
  });

  Scenario('the user-mirror upsert works under the limited role', ({ When, Then, And }) => {
    const newId = randomUUID();
    const email = `mirror-${newId.slice(0, 8)}@example.com`;
    let returnedId = '';
    When('the user-mirror upserts a brand-new user as app_runtime', async () => {
      // Runs getOrCreateUser AS app_runtime (RLS in force). It must pin
      // app.current_user transaction-locally for the INSERT to pass WITH CHECK.
      const row = await getOrCreateUser(runtimeTestDb() as unknown as Database, {
        id: newId,
        email,
      });
      returnedId = row.id;
    });
    Then('the upsert returns that user row', () => {
      expect(returnedId).toBe(newId);
    });
    And('that user row exists in the database', async () => {
      // Verify as the owner (sees all rows).
      const { rows } = await (getTestDb() as unknown as Database).execute<{ id: string }>(
        sql`select id from users where id = ${newId}`,
      );
      expect(rows[0]?.id).toBe(newId);
    });
  });

  Scenario('the limited role has the grants it needs on global tables', ({ Then, And }) => {
    Then('app_runtime can read and write users', async () => {
      const owner = getTestDb() as unknown as Database;
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const { rows } = await owner.execute<{ ok: boolean }>(
          sql`select has_table_privilege('app_runtime', 'public.users', ${priv}) as ok`,
        );
        expect(rows[0]?.ok, `app_runtime should have ${priv} on users`).toBe(true);
      }
    });
    And('app_runtime can read tenants', async () => {
      const owner = getTestDb() as unknown as Database;
      const { rows } = await owner.execute<{ ok: boolean }>(
        sql`select has_table_privilege('app_runtime', 'public.tenants', 'SELECT') as ok`,
      );
      expect(rows[0]?.ok).toBe(true);
    });
  });
});
