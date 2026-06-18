import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import * as schema from './schema.js';

const log = createLogger('db');

// Base type so a pool-backed instance (`drizzle(pool)`) and a request-scoped
// one (`drizzle(client)`) are interchangeable — they differ only in `$client`.
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

// FHS-345 — request-scoped DB context. When a request runs inside
// `runWithRequestDb`, every `getDb()` in that async call tree returns the
// SAME dedicated pooled connection. That lets a later story (FHS-346) pin a
// per-request `app.current_tenant` GUC on that one connection for RLS,
// without touching the ~69 `getDb()` call sites. Outside a request,
// `getDb()` falls back to the pool-backed root instance.
const als = new AsyncLocalStorage<{ db: Database }>();

export function getDb(): Database {
  return als.getStore()?.db ?? getRootDb();
}

/**
 * Run `fn` with a dedicated pooled connection bound to the request via
 * AsyncLocalStorage. The connection is always released afterwards. Nested
 * calls reuse the outer request's connection (no double checkout).
 */
export async function runWithRequestDb<T>(fn: () => Promise<T>): Promise<T> {
  // Already inside a request scope — reuse it; the outer call owns the
  // connection and its release. Not a leak.
  if (als.getStore()) return fn();
  let client: pg.PoolClient;
  try {
    client = await getRootPool().connect();
  } catch (err) {
    // Couldn't get a connection — DB momentarily unavailable, or a route /
    // test that never touches the DB (e.g. /api/kid/me returns token claims).
    // Don't hard-fail the request: run on the root db. A handler that DOES
    // query will surface its own error, and once RLS is on (FHS-348) the
    // root connection has no tenant GUC, so it still fails closed (no rows).
    log.warn({ err }, 'request-db: could not acquire a connection; using root db');
    return fn();
  }
  try {
    const db = drizzle(client, { schema });
    return await als.run({ db }, fn);
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
    _rootDb = undefined;
  }
}
