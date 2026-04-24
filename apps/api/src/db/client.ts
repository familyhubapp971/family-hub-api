import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import * as schema from './schema.js';

const log = createLogger('db');

// Lazy pool so vitest files that never touch the DB don't open real
// connections. First call to `getDb()` constructs the pool once.
let _pool: pg.Pool | undefined;
let _db: ReturnType<typeof drizzle> | undefined;

export function getDb() {
  if (_db) return _db;
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
  _db = drizzle(_pool, { schema });
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
    _db = undefined;
  }
}

export type Database = ReturnType<typeof getDb>;
