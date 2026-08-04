import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import * as schema from './schema.js';

const log = createLogger('db');

// Base type so a pool-backed instance (`drizzle(pool)`) and a request-scoped
// one (`drizzle(client)`) are interchangeable: they differ only in `$client`.
export type Database = NodePgDatabase<typeof schema>;

// Lazy pool so vitest files that never touch the DB don't open real
// connections. First DB access constructs the pool once.
let _pool: pg.Pool | undefined;
let _rootDb: Database | undefined;

function getRootPool(): pg.Pool {
  if (_pool) return _pool;
  _pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    application_name: '@familyhub/api',
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  _pool.on('error', (err) => {
    // An idle client emitting 'error' would otherwise crash the process.
    log.error({ err }, 'unexpected postgres pool error');
  });
  return _pool;
}

/**
 * The pool-backed Drizzle instance. Each query borrows + returns a pooled
 * connection. Used by background work / startup and as the fallback when no
 * request-scoped client is active.
 */
export function getRootDb(): Database {
  if (!_rootDb) _rootDb = drizzle(getRootPool(), { schema });
  return _rootDb;
}

// FHS-345: request-scoped DB context. When a request runs inside
// `runWithRequestDb`, every `getDb()` in that async call tree returns the
// SAME dedicated pooled connection. That lets a later story (FHS-346) pin a
// per-request `app.current_tenant` GUC on that one connection for RLS,
// without touching the ~69 `getDb()` call sites. Outside a request,
// `getDb()` falls back to the pool-backed root instance.
const als = new AsyncLocalStorage<{ db: Database }>();

export function getDb(): Database {
  return als.getStore()?.db ?? getRootDb();
}

// The empty sentinel for "no tenant". RLS policies read the GUC with
// `NULLIF(current_setting('app.current_tenant', true), '')::uuid`, so both an
// UNSET GUC and this empty value resolve to NULL → every row comparison fails
// → zero rows / rejected writes (fail closed). We never cast '' to uuid.
const TENANT_GUC = 'app.current_tenant';

/**
 * Run `fn` with a dedicated pooled connection bound to the request via
 * AsyncLocalStorage, with the per-request tenant pinned on that connection
 * (FHS-346). The connection is always released afterwards, and the tenant GUC
 * is ALWAYS reset to the empty sentinel before release so a reused connection
 * can never carry the previous request's tenant. Nested calls reuse the outer
 * request's connection + tenant (no double checkout, no re-pin).
 *
 * @param opts.tenantId resolved tenant uuid, or undefined for public /
 *   tenant-less requests (pinned as the empty sentinel: never a stale value).
 */
export async function runWithRequestDb<T>(
  fn: () => Promise<T>,
  opts: { tenantId?: string | undefined } = {},
): Promise<T> {
  // Already inside a request scope: reuse it; the outer call owns the
  // connection, its tenant GUC, and its release. Not a leak.
  if (als.getStore()) return fn();
  let client: pg.PoolClient;
  try {
    client = await getRootPool().connect();
  } catch (err) {
    // Couldn't get a connection: DB momentarily unavailable, or a route /
    // test that never touches the DB (e.g. /api/kid/me returns token claims).
    // Don't hard-fail the request: run on the root db. A handler that DOES
    // query will surface its own error, and once RLS is on (FHS-348) the
    // root connection has no tenant GUC, so it still fails closed (no rows).
    log.warn({ err }, 'request-db: could not acquire a connection; using root db');
    return fn();
  }
  try {
    // Pin the tenant for THIS connection's session. set_config(..., false) is
    // session-local (not transaction-local), so it covers our many
    // non-transactional queries. Empty sentinel for tenant-less requests.
    await client.query(`select set_config('${TENANT_GUC}', $1, false)`, [opts.tenantId ?? '']);
    const db = drizzle(client, { schema });
    return await als.run({ db }, fn);
  } finally {
    // Guaranteed reset BEFORE the connection returns to the pool. If the
    // reset itself fails, discard the connection (release(err)) rather than
    // risk it re-entering the pool still carrying a real tenant.
    try {
      await client.query(`select set_config('${TENANT_GUC}', '', false)`);
      client.release();
    } catch (resetErr) {
      log.error({ err: resetErr }, 'request-db: failed to reset tenant GUC; discarding connection');
      client.release(resetErr as Error);
    }
  }
}

/**
 * Pin a specific tenant on THIS request's connection (FHS-354), for routes that
 * learn their tenant from somewhere other than resolveTenant: the kid token,
 * or a public slug lookup. Their reads/writes then pass RLS once the app runs
 * as app_runtime. Safe before the flip (no policy reads the GUC yet). The reset
 * is handled by runWithRequestDb's finally; this only ever runs inside an
 * /api/* request, so getDb() is the dedicated request connection.
 */
export async function pinRequestTenant(tenantId: string): Promise<void> {
  await getDb().execute(sql`select set_config('${sql.raw(TENANT_GUC)}', ${tenantId}, false)`);
}

export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
    _rootDb = undefined;
  }
}
