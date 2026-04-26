// Vitest globalSetup — runs once per `pnpm test:integration` invocation,
// BEFORE any spec. Asserts the test DB is reachable. Schema + RLS push
// will land here once Sprint 1 (FHS-1) adds the Drizzle tables.

import pg from 'pg';

function url(): string {
  return (
    process.env['DATABASE_URL_TEST'] ??
    'postgres://fh_test:fh_test@localhost:5433/familyhub_test'
  );
}

export async function setup(): Promise<void> {
  const client = new pg.Client({ connectionString: url() });
  try {
    await client.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[integration] cannot reach test Postgres at ${url()}\n` +
        `  ${message}\n` +
        `  Hint: docker compose -f docker-compose.test.yml up -d`,
    );
  }
  // Sanity ping.
  const res = await client.query<{ now: Date }>('SELECT NOW() AS now');
  if (!res.rows[0]) {
    throw new Error('[integration] SELECT NOW() returned no row');
  }
  await client.end();

  // FHS-1 lands here:
  //   - drop + recreate the test schema (idempotent runs)
  //   - npx drizzle-kit push --force --config apps/api/drizzle.config.ts
  //   - apply RLS policies via raw SQL (drizzle-kit doesn't manage them yet)
}

export async function teardown(): Promise<void> {
  // No-op for now. Once we hold long-lived pools across specs, close
  // them here.
}
