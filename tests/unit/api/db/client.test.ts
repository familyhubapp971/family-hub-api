import { describe, expect, it, vi } from 'vitest';

// FHS-345 — verify the request-scoped DB dispatch (AsyncLocalStorage) without a
// real database: mock `pg` so the pool hands out fake clients we can identify.

const released: { count: number } = { count: 0 };
const failConnect = { value: false };

vi.mock('pg', () => {
  class FakePool {
    on() {}
    connect() {
      if (failConnect.value) return Promise.reject(new Error('ECONNREFUSED'));
      // A fresh fake client per checkout, so request-scoped Drizzle instances
      // are distinguishable by identity.
      return Promise.resolve({
        release() {
          released.count += 1;
        },
        query: () => Promise.resolve({ rows: [] }),
      });
    }
    end() {
      return Promise.resolve();
    }
  }
  return { default: { Pool: FakePool } };
});

import { getDb, getRootDb, runWithRequestDb } from '../../../../apps/api/src/db/client.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('FHS-345 — request-scoped DB via AsyncLocalStorage', () => {
  it('getDb() outside a request returns the pool-backed root db', () => {
    expect(getDb()).toBe(getRootDb());
  });

  it('getDb() inside runWithRequestDb returns a dedicated db (not the root)', async () => {
    let inner: unknown;
    await runWithRequestDb(async () => {
      inner = getDb();
    });
    expect(inner).toBeDefined();
    expect(inner).not.toBe(getRootDb());
  });

  it('releases the connection when the request finishes', async () => {
    const before = released.count;
    await runWithRequestDb(async () => {
      getDb();
    });
    expect(released.count).toBe(before + 1);
  });

  it('still releases the connection if the request throws', async () => {
    const before = released.count;
    await expect(
      runWithRequestDb(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(released.count).toBe(before + 1);
  });

  it('two concurrent requests each get their own db', async () => {
    let a: unknown;
    let b: unknown;
    await Promise.all([
      runWithRequestDb(async () => {
        a = getDb();
        await tick();
      }),
      runWithRequestDb(async () => {
        b = getDb();
        await tick();
      }),
    ]);
    expect(a).not.toBe(b);
  });

  it('falls back to the root db (does not throw) when a connection cannot be acquired', async () => {
    failConnect.value = true;
    try {
      let inner: unknown;
      await expect(
        runWithRequestDb(async () => {
          inner = getDb();
          return 'ok';
        }),
      ).resolves.toBe('ok');
      // No dedicated client → getDb() falls back to the root db.
      expect(inner).toBe(getRootDb());
    } finally {
      failConnect.value = false;
    }
  });

  it('nested runWithRequestDb reuses the outer request connection', async () => {
    const before = released.count;
    let outer: unknown;
    let nested: unknown;
    await runWithRequestDb(async () => {
      outer = getDb();
      await runWithRequestDb(async () => {
        nested = getDb();
      });
    });
    expect(nested).toBe(outer);
    // Only one checkout/release for the whole nested flow.
    expect(released.count).toBe(before + 1);
  });
});
