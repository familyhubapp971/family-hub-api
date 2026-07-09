import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOrCreateUser, resetUserMirrorCache } from '../../../../apps/api/src/lib/user-mirror.js';
import type { Database } from '../../../../apps/api/src/db/client.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-192 — getOrCreateUser unit coverage.
//
// These tests mock the Drizzle query builder. The integration tier
// (tests/integration/specs/user-mirror.spec.ts) exercises the real SQL
// path against Postgres on :5433. Here we just verify the helper:
//
//   - issues an INSERT ... ON CONFLICT DO UPDATE RETURNING in one call,
//   - returns the row Drizzle hands back,
//   - throws when Drizzle (impossibly) returns no row.

interface UpsertChain {
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  onConflictDoUpdate: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  // FHS-349 — set_config('app.current_user', …) inside the mirror transaction.
  execute: ReturnType<typeof vi.fn>;
}

function buildMockDb(returningRows: User[]): { db: Database; chain: UpsertChain } {
  const chain: UpsertChain = {
    insert: vi.fn(),
    values: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    returning: vi.fn().mockResolvedValue(returningRows),
    execute: vi.fn().mockResolvedValue(undefined),
  };
  // Build the chain bottom-up so `tx.insert(...).values(...).onConflictDoUpdate(...).returning()`
  // walks through every spy and lands on the resolved rows.
  chain.onConflictDoUpdate.mockReturnValue({ returning: chain.returning });
  chain.values.mockReturnValue({ onConflictDoUpdate: chain.onConflictDoUpdate });
  chain.insert.mockReturnValue({ values: chain.values });

  // FHS-349 — getOrCreateUser now runs inside db.transaction(tx => …); the tx
  // exposes the same insert chain plus execute() for the set_config GUC pin.
  const tx = { insert: chain.insert, execute: chain.execute };
  const db = {
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<User>) => cb(tx)),
  } as unknown as Database;
  return { db, chain };
}

const ROW: User = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'mirror@example.com',
  createdAt: new Date('2026-04-29T00:00:00.000Z'),
  updatedAt: new Date('2026-04-29T00:00:00.000Z'),
};

describe('FHS-192 — getOrCreateUser (unit)', () => {
  it('upserts via INSERT ... ON CONFLICT DO UPDATE and returns the row', async () => {
    const { db, chain } = buildMockDb([ROW]);

    const result = await getOrCreateUser(db, { id: ROW.id, email: ROW.email });

    expect(result).toEqual(ROW);
    // FHS-349 — pins app.current_user (set_config) before the upsert so the
    // users RLS self-isolation policy permits it under the app_runtime role.
    expect(chain.execute).toHaveBeenCalledTimes(1);
    // Single insert call — warm and cold paths share the SQL statement.
    expect(chain.insert).toHaveBeenCalledTimes(1);
    expect(chain.values).toHaveBeenCalledWith({ id: ROW.id, email: ROW.email });
    // The conflict target is the primary key; the SET refreshes email +
    // updatedAt so a Supabase-side email change propagates next request.
    const [conflictArg] = chain.onConflictDoUpdate.mock.calls[0] as [
      {
        target: unknown;
        set: { email: string; updatedAt: Date };
      },
    ];
    expect(conflictArg.set.email).toBe(ROW.email);
    expect(conflictArg.set.updatedAt).toBeInstanceOf(Date);
    expect(chain.returning).toHaveBeenCalledTimes(1);
  });

  it('returns the conflict-update row when the user already existed', async () => {
    // Same shape as cold-path: ON CONFLICT DO UPDATE RETURNING always
    // produces a row. The mock just hands back the "existing" row to
    // simulate the warm path where an email was refreshed.
    const refreshed: User = { ...ROW, email: 'mirror+changed@example.com' };
    const { db } = buildMockDb([refreshed]);

    const result = await getOrCreateUser(db, { id: refreshed.id, email: refreshed.email });

    expect(result.email).toBe('mirror+changed@example.com');
    expect(result.id).toBe(refreshed.id);
  });

  it('throws when the upsert returns no row (defensive — should be unreachable)', async () => {
    const { db } = buildMockDb([]);

    await expect(getOrCreateUser(db, { id: ROW.id, email: ROW.email })).rejects.toThrow(
      /upsert returned no row/,
    );
  });
});

// FHS-465 — per-replica cache: once (id, email) is confirmed, skip the DB.
describe('FHS-465 — getOrCreateUser cache', () => {
  beforeEach(() => {
    process.env['USER_MIRROR_CACHE'] = 'on';
    resetUserMirrorCache();
  });
  afterEach(() => {
    delete process.env['USER_MIRROR_CACHE'];
    resetUserMirrorCache();
  });

  it('hits the DB once, then serves the same (id, email) from cache', async () => {
    const { db } = buildMockDb([ROW]);

    const first = await getOrCreateUser(db, { id: ROW.id, email: ROW.email });
    const second = await getOrCreateUser(db, { id: ROW.id, email: ROW.email });

    expect(first).toEqual(ROW);
    expect(second).toEqual(ROW);
    // Second call never touched the database.
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('re-syncs (misses cache) when the email changes', async () => {
    const { db } = buildMockDb([ROW]);

    await getOrCreateUser(db, { id: ROW.id, email: ROW.email });
    await getOrCreateUser(db, { id: ROW.id, email: 'changed@example.com' });

    // Different email → different key → the upsert runs again.
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });
});
