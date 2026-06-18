// Vitest globalSetup — runs once per `pnpm test:integration` invocation,
// BEFORE any spec. Asserts the test DB is reachable and applies all
// Drizzle migration SQL files so specs see the schema.
//
// FHS-192 wired up the first migration (users mirror table). Subsequent
// tickets just drop new SQL files into apps/api/drizzle/ and the loop
// below picks them up in journal order.

import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

function url(): string {
  return (
    process.env['DATABASE_URL_TEST'] ?? 'postgres://fh_test:fh_test@localhost:5433/familyhub_test'
  );
}

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../apps/api/drizzle');

interface JournalEntry {
  idx: number;
  tag: string;
}

interface Journal {
  entries: JournalEntry[];
}

async function readJournal(): Promise<JournalEntry[]> {
  const journalPath = path.join(MIGRATIONS_DIR, 'meta', '_journal.json');
  try {
    const raw = await fs.readFile(journalPath, 'utf8');
    const journal = JSON.parse(raw) as Journal;
    return [...journal.entries].sort((a, b) => a.idx - b.idx);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function applyMigrations(client: pg.Client): Promise<void> {
  const entries = await readJournal();
  if (entries.length === 0) return;

  // Drop + recreate the public schema for a clean slate. Per ADR 0001
  // this is acceptable for the integration test DB — the docker-compose
  // service uses tmpfs, so there's nothing valuable to preserve.
  await client.query('DROP SCHEMA IF EXISTS public CASCADE');
  await client.query('CREATE SCHEMA public');
  await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');

  for (const entry of entries) {
    const file = path.join(MIGRATIONS_DIR, `${entry.tag}.sql`);
    const sql = await fs.readFile(file, 'utf8');
    // Drizzle's --> statement-breakpoint markers split logical statements
    // when present; plain pg.Client.query handles a multi-statement
    // string fine, so we can pass the file as-is.
    await client.query(sql);
  }
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
  await applyMigrations(client);
  await ensureRuntimeRolePassword(client);
  await client.end();
}

// FHS-348/350 — give the app_runtime role (created by migration 0027) a
// password so the RLS proof tests can log in AS that limited, non-BYPASSRLS
// role. The default getTestDb() connects as the superuser (fh_test), which
// bypasses RLS and so can't prove isolation. Test-only; staging provisions this
// out of band (FHS-351). No-op if the role isn't present.
async function ensureRuntimeRolePassword(client: pg.Client): Promise<void> {
  const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'");
  if (rows.length === 0) return;
  const pw = process.env['DATABASE_URL_TEST_RUNTIME_PASSWORD'] ?? 'app_runtime';
  // ALTER ROLE ... PASSWORD takes no bind parameter (it's DDL), so the value is
  // interpolated. Restrict it to a safe charset so a hostile env var can't
  // inject SQL into the test bootstrap.
  if (!/^[A-Za-z0-9_-]+$/.test(pw)) {
    throw new Error('DATABASE_URL_TEST_RUNTIME_PASSWORD must match [A-Za-z0-9_-]+');
  }
  await client.query(`ALTER ROLE app_runtime WITH LOGIN PASSWORD '${pw}'`);
}

export async function teardown(): Promise<void> {
  // No-op for now. Once we hold long-lived pools across specs, close
  // them here.
}
