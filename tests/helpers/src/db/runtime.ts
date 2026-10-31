import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

// FHS-348/350: a SECOND test pool that logs in as the limited `app_runtime`
// role (no BYPASSRLS), so RLS proof tests see exactly what production will once
// the app flips to that role (FHS-351). The default getTestDb() logs in as the
// superuser (fh_test), which BYPASSES RLS and therefore can never prove
// isolation. The role's password is set by the integration global-setup after
// migrating (ALTER ROLE app_runtime ... PASSWORD).

let _pool: pg.Pool | undefined;

export function runtimeTestPool(): pg.Pool {
  if (_pool) return _pool;
  const url =
    process.env['DATABASE_URL_TEST_RUNTIME'] ??
    'postgres://app_runtime:app_runtime@localhost:5433/familyhub_test';
  _pool = new pg.Pool({
    connectionString: url,
    application_name: '@familyhub/test-utils[app_runtime]',
    max: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  });
  _pool.on('error', (err) => {
    console.error('[test-utils] app_runtime pool error', err);
  });
  return _pool;
}

export async function closeRuntimeTestPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
  }
}

/**
 * A Drizzle instance over the app_runtime pool, for exercising real query
 * helpers (e.g. getOrCreateUser) under RLS as the limited role, not the
 * superuser. No schema is bound; pass `sql` / table objects as the caller needs.
 */
export function runtimeTestDb() {
  return drizzle(runtimeTestPool());
}

/**
 * Run `fn` on an app_runtime connection with `app.current_user` pinned to
 * `userId`, or cleared (null) for the "no user context → fail closed" case.
 * Mirror of {@link asRuntimeTenant} for the global users table policy (FHS-349).
 */
export async function asRuntimeUser<T>(
  userId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await runtimeTestPool().connect();
  try {
    await client.query("select set_config('app.current_user', $1, false)", [userId ?? '']);
    return await fn(client);
  } finally {
    try {
      await client.query("select set_config('app.current_user', '', false)");
      client.release();
    } catch (resetErr) {
      client.release(resetErr as Error);
    }
  }
}

/**
 * Run `fn` on an app_runtime connection with `app.current_tenant` pinned to
 * `tenantId`, or cleared (the empty sentinel) when `tenantId` is null, which
 * is the "no tenant context → fail closed" case. Mirrors the prod request
 * middleware (FHS-346): always resets the GUC and releases the connection.
 */
export async function asRuntimeTenant<T>(
  tenantId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await runtimeTestPool().connect();
  try {
    await client.query("select set_config('app.current_tenant', $1, false)", [tenantId ?? '']);
    return await fn(client);
  } finally {
    // Mirror the prod reset (FHS-346): clear the GUC before the connection
    // returns to the pool; if the reset fails, discard the connection rather
    // than risk a stale tenant poisoning the next test (a false green).
    try {
      await client.query("select set_config('app.current_tenant', '', false)");
      client.release();
    } catch (resetErr) {
      client.release(resetErr as Error);
    }
  }
}
