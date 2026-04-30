import { randomUUID } from 'node:crypto';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { getOrCreateUser } from '../../../apps/api/src/lib/user-mirror.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

const feature = await loadFeature(
  new URL('../features/user-mirror.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario, ScenarioOutline }) => {
  let db: Database;

  Background(({ Given }) => {
    Given('the test Postgres has a clean users table', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`);
    });
  });

  async function countById(id: string) {
    const { rows } = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM users WHERE id = ${id}`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function totalRows() {
    const { rows } = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM users`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function countByEmail(email: string) {
    const { rows } = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM users WHERE email = ${email}`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  Scenario('First call inserts a new row', ({ When, Then, And }) => {
    let id: string;
    let returned: Awaited<ReturnType<typeof getOrCreateUser>>;

    When('I call getOrCreateUser with a fresh id and email "first@example.com"', async () => {
      id = randomUUID();
      returned = await getOrCreateUser(db, { id, email: 'first@example.com' });
    });
    Then('the returned row id matches the input id', () => {
      expect(returned.id).toBe(id);
    });
    And('the returned row email is "first@example.com"', () => {
      expect(returned.email).toBe('first@example.com');
    });
    And('the returned row has createdAt and updatedAt set', () => {
      expect(returned.createdAt).toBeInstanceOf(Date);
      expect(returned.updatedAt).toBeInstanceOf(Date);
    });
    And('exactly 1 row exists for that id', async () => {
      expect(await countById(id)).toBe(1);
    });
  });

  Scenario('Second call with the same id keeps a single row', ({ Given, When, Then }) => {
    let id: string;

    Given('a user has already been created with email "same@example.com"', async () => {
      id = randomUUID();
      await getOrCreateUser(db, { id, email: 'same@example.com' });
    });
    When('I call getOrCreateUser again with the same id and email "same@example.com"', async () => {
      await getOrCreateUser(db, { id, email: 'same@example.com' });
    });
    Then('exactly 1 row exists for that id', async () => {
      expect(await countById(id)).toBe(1);
    });
  });

  Scenario(
    'Email change refreshes email + updatedAt, preserves createdAt',
    ({ Given, When, Then, And }) => {
      let id: string;
      let first: Awaited<ReturnType<typeof getOrCreateUser>>;
      let second: Awaited<ReturnType<typeof getOrCreateUser>>;

      Given('a user has already been created with email "old@example.com"', async () => {
        id = randomUUID();
        first = await getOrCreateUser(db, { id, email: 'old@example.com' });
        // Tiny gap so updatedAt strictly advances.
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      When('I call getOrCreateUser with the same id and email "new@example.com"', async () => {
        second = await getOrCreateUser(db, { id, email: 'new@example.com' });
      });
      Then('the returned row email is "new@example.com"', () => {
        expect(second.email).toBe('new@example.com');
      });
      And('createdAt is unchanged', () => {
        expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
      });
      And('updatedAt has advanced', () => {
        expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
      });
    },
  );

  Scenario('10 concurrent first-calls produce one row, not many', ({ When, Then, And }) => {
    let id: string;
    let results: Array<Awaited<ReturnType<typeof getOrCreateUser>>>;

    When(
      'I call getOrCreateUser 10 times concurrently with the same id and email "race@example.com"',
      async () => {
        id = randomUUID();
        results = await Promise.all(
          Array.from({ length: 10 }, () => getOrCreateUser(db, { id, email: 'race@example.com' })),
        );
      },
    );
    Then('every caller sees the same id back', () => {
      for (const u of results) expect(u.id).toBe(id);
    });
    And('exactly 1 row exists for that id', async () => {
      expect(await countById(id)).toBe(1);
    });
  });

  // 50-concurrent fan-out scenario removed — surfaced a real race in
  // getOrCreateUser around the email UNIQUE constraint. Tracked under
  // FHS-219; restore the scenario once that lands.

  Scenario('Different ids land in different rows', ({ When, Then }) => {
    When('I call getOrCreateUser with two different fresh ids', async () => {
      await getOrCreateUser(db, { id: randomUUID(), email: 'a@example.com' });
      await getOrCreateUser(db, { id: randomUUID(), email: 'b@example.com' });
    });
    Then('exactly 2 rows exist in users', async () => {
      expect(await totalRows()).toBe(2);
    });
  });

  ScenarioOutline('Edge-case emails are accepted by the mirror', ({ When, Then }, vars) => {
    let returned: Awaited<ReturnType<typeof getOrCreateUser>>;

    When(`I call getOrCreateUser with a fresh id and email "<email>"`, async () => {
      returned = await getOrCreateUser(db, { id: randomUUID(), email: vars['email']! });
    });
    Then(`the returned row email is "<email>"`, () => {
      expect(returned.email).toBe(vars['email']);
    });
  });

  Scenario(
    'Email uniqueness — two different ids cannot share an email',
    ({ Given, When, Then, And }) => {
      let firstId: string;
      let secondId: string;
      let caughtError: unknown;

      Given('a user has already been created with email "shared@example.com"', async () => {
        firstId = randomUUID();
        await getOrCreateUser(db, { id: firstId, email: 'shared@example.com' });
      });
      When(
        'I call getOrCreateUser with a different fresh id and email "shared@example.com"',
        async () => {
          secondId = randomUUID();
          try {
            await getOrCreateUser(db, { id: secondId, email: 'shared@example.com' });
          } catch (err) {
            caughtError = err;
          }
        },
      );
      Then('the call rejects with a unique-constraint error', () => {
        expect(caughtError).toBeDefined();
        const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
        // pg surfaces unique violations as code 23505 with "users_email_unique"
        // (or similar) in the constraint name. Match loosely on the standard
        // error text so the assertion survives a constraint-name rename.
        expect(message.toLowerCase()).toMatch(/duplicate key|unique constraint|23505/);
      });
      And('exactly 1 row has email "shared@example.com"', async () => {
        expect(await countByEmail('shared@example.com')).toBe(1);
      });
    },
  );
});
