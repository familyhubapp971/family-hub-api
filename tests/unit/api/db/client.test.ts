import { beforeEach, describe, expect, it, vi } from 'vitest';

// FHS-345: verify the request-scoped DB dispatch (AsyncLocalStorage) without a
// real database: mock `pg` so the pool hands out fake clients we can identify.

const released: { count: number } = { count: 0 };
const failConnect = { value: false };
// FHS-346: toggle to make a client's RESET query (set_config to '') reject,
// so we can prove the connection is discarded rather than returned dirty.
const failReset = { value: false };
// Every set_config call across all fake clients, in order, as [name, value].
const guc: { calls: Array<[string, string]> } = { calls: [] };
// Release calls with the arg passed (undefined = clean return, Error = discard).
const releaseArgs: { calls: unknown[] } = { calls: [] };

function resetMockState() {
  released.count = 0;
  failConnect.value = false;
  failReset.value = false;
  guc.calls = [];
  releaseArgs.calls = [];
}

vi.mock('pg', () => {
  class FakePool {
    on() {}
    connect() {
      if (failConnect.value) return Promise.reject(new Error('ECONNREFUSED'));
      // A fresh fake client per checkout, so request-scoped Drizzle instances
      // are distinguishable by identity.
      return Promise.resolve({
        release(arg?: unknown) {
          released.count += 1;
          releaseArgs.calls.push(arg);
        },
        query(a: string | { text: string; values?: unknown[] }, b?: unknown[]) {
          // pg is called either as (text, params) by runWithRequestDb or as a
          // query-config object by drizzle's execute(): handle both.
          const text = typeof a === 'string' ? a : a.text;
          const params = typeof a === 'string' ? b : (a.values ?? b);
          // Record set_config('app.current_tenant', $1|'', false) calls. The
          // entry call binds $1 (the tenant); the reset call inlines ''.
          const m = /set_config\('([^']+)',\s*(\$1|'')/.exec(text);
          if (m) {
            const value = m[2] === '$1' ? String(params?.[0] ?? '') : '';
            guc.calls.push([m[1] as string, value]);
            if (value === '' && failReset.value) {
              return Promise.reject(new Error('reset failed'));
            }
          }
          return Promise.resolve({ rows: [] });
        },
      });
    }
    end() {
      return Promise.resolve();
    }
  }
  return { default: { Pool: FakePool } };
});

import {
  getDb,
  getRootDb,
  runWithRequestDb,
  pinRequestTenant,
} from '../../../../apps/api/src/db/client.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('FHS-345: request-scoped DB via AsyncLocalStorage', () => {
  beforeEach(resetMockState);

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

describe('FHS-346: per-request tenant GUC (set + guaranteed reset)', () => {
  beforeEach(resetMockState);

  const TENANT_A = '11111111-1111-1111-1111-111111111111';

  it('pins app.current_tenant to the resolved tenant on entry', async () => {
    await runWithRequestDb(async () => getDb(), { tenantId: TENANT_A });
    // First set_config call sets the tenant; it must target app.current_tenant.
    expect(guc.calls[0]).toEqual(['app.current_tenant', TENANT_A]);
  });

  it('resets the GUC to the empty sentinel before releasing the connection', async () => {
    await runWithRequestDb(async () => getDb(), { tenantId: TENANT_A });
    // Last GUC call is the reset to '' ...
    expect(guc.calls.at(-1)).toEqual(['app.current_tenant', '']);
    // ... and the connection returned to the pool cleanly (no discard arg).
    expect(releaseArgs.calls).toEqual([undefined]);
  });

  it('pins the empty sentinel for a tenant-less (public) request', async () => {
    await runWithRequestDb(async () => getDb()); // no tenantId
    expect(guc.calls[0]).toEqual(['app.current_tenant', '']);
    expect(guc.calls.at(-1)).toEqual(['app.current_tenant', '']);
  });

  it('still resets the GUC when the request throws', async () => {
    await expect(
      runWithRequestDb(
        async () => {
          throw new Error('boom');
        },
        { tenantId: TENANT_A },
      ),
    ).rejects.toThrow('boom');
    expect(guc.calls[0]).toEqual(['app.current_tenant', TENANT_A]);
    expect(guc.calls.at(-1)).toEqual(['app.current_tenant', '']);
  });

  it('discards the connection (does not return it dirty) if the reset fails', async () => {
    failReset.value = true;
    await runWithRequestDb(async () => getDb(), { tenantId: TENANT_A });
    // Released with an Error arg → pg destroys the client instead of pooling it.
    expect(releaseArgs.calls).toHaveLength(1);
    expect(releaseArgs.calls[0]).toBeInstanceOf(Error);
  });

  it('pinRequestTenant sets app.current_tenant to the given tenant on the request connection', async () => {
    await runWithRequestDb(async () => {
      await pinRequestTenant('tenant-x');
    });
    // FHS-354: kid/public routes re-pin their own tenant mid-request.
    expect(guc.calls).toContainEqual(['app.current_tenant', 'tenant-x']);
  });

  it('does not re-pin the tenant for a nested call (outer owns the GUC)', async () => {
    await runWithRequestDb(
      async () => {
        await runWithRequestDb(async () => getDb(), { tenantId: 'should-be-ignored' });
      },
      { tenantId: TENANT_A },
    );
    // Exactly one set (entry) + one reset: the nested call neither set nor reset.
    expect(guc.calls).toEqual([
      ['app.current_tenant', TENANT_A],
      ['app.current_tenant', ''],
    ]);
  });
});
