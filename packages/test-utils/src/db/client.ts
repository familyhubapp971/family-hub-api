import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

// Test-only Postgres pool. Separate from the prod pool in apps/api so
// integration tests never touch the live connection. Defaults to a
// docker-compose.test.yml service on port 5433 (the FHS-181 setup).
//
// Override via env: DATABASE_URL_TEST=postgres://...

let _pool: pg.Pool | undefined;
let _db: ReturnType<typeof drizzle> | undefined;

export function getTestDb() {
  if (_db) return _db;
  const url =
    process.env['DATABASE_URL_TEST'] ??
    'postgres://fh_test:fh_test@localhost:5433/familyhub_test';
  _pool = new pg.Pool({
    connectionString: url,
    application_name: '@familyhub/test-utils',
    max: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  });
  _pool.on('error', (err) => {
    // Don't crash the test process on idle-client error.
    // eslint-disable-next-line no-console
    console.error('[test-utils] postgres pool error', err);
  });
  _db = drizzle(_pool);
  return _db;
}

export async function closeTestDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
    _db = undefined;
  }
}
