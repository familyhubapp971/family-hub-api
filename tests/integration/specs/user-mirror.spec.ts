import { randomUUID } from 'node:crypto';
import { describe, beforeEach, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getOrCreateUser } from '../../../apps/api/src/lib/user-mirror.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

// FHS-192 — getOrCreateUser against real Postgres on :5433.
//
// Verifies:
//   1. First call inserts a row, second call is idempotent.
//   2. Concurrent first-calls for the same id resolve to one row, not two
//      (PRIMARY KEY constraint + ON CONFLICT do the work).
//   3. A subsequent call with a changed email refreshes the row.
//
// We use the test-utils Drizzle pool. Each test starts with a clean
// users table via TRUNCATE — quick + sufficient because we only have
// one table today and no FK dependencies on users yet.

describe('FHS-192 — getOrCreateUser (integration: real Postgres)', () => {
  let db: Database;

  beforeEach(async () => {
    db = getTestDb() as unknown as Database;
    await db.execute(sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`);
  });

  it('inserts a new row on first call', async () => {
    const id = randomUUID();
    const user = await getOrCreateUser(db, { id, email: 'first@example.com' });

    expect(user.id).toBe(id);
    expect(user.email).toBe('first@example.com');
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);

    const { rows } = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM users WHERE id = ${id}`,
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('is idempotent — second call with the same id keeps a single row', async () => {
    const id = randomUUID();
    const email = 'same@example.com';

    await getOrCreateUser(db, { id, email });
    await getOrCreateUser(db, { id, email });

    const { rows } = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM users WHERE id = ${id}`,
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('refreshes email + updatedAt when the JWT email changes', async () => {
    const id = randomUUID();

    const first = await getOrCreateUser(db, { id, email: 'old@example.com' });
    // Tiny gap so updatedAt strictly advances. Postgres timestamps have
    // microsecond resolution; a 5ms wait is well within that margin.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await getOrCreateUser(db, { id, email: 'new@example.com' });

    expect(second.id).toBe(id);
    expect(second.email).toBe('new@example.com');
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
    expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
  });

  it('concurrent first-calls for the same id produce one row, not two', async () => {
    const id = randomUUID();
    const email = 'race@example.com';

    // Fire 10 calls in parallel. Without the ON CONFLICT clause the
    // PRIMARY KEY would surface a unique-violation; with it, every call
    // succeeds and only one row exists.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => getOrCreateUser(db, { id, email })),
    );

    // All callers see the same id back.
    for (const u of results) expect(u.id).toBe(id);

    const { rows } = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM users WHERE id = ${id}`,
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('different ids land in different rows', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await getOrCreateUser(db, { id: a, email: 'a@example.com' });
    await getOrCreateUser(db, { id: b, email: 'b@example.com' });

    const { rows } = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM users`,
    );
    expect(rows[0]?.count).toBe('2');
  });
});
