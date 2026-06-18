#!/usr/bin/env node
// FHS-351 — apply the RLS role, policies, and grants idempotently, as the OWNER
// (migrate) role.
//
// Why this exists: staging/prod boot with `drizzle-kit push --force`, which
// diffs schema.ts and KNOWS NOTHING about roles, RLS, policies, or grants — so
// it never applies migrations 0027/0028/0029, and worse, if it recreates a
// table it drops that table's grants to app_runtime. This script re-applies all
// three RLS migrations (every statement is idempotent: CREATE ROLE guarded,
// CREATE OR REPLACE FUNCTION, ENABLE/FORCE no-ops, DROP POLICY IF EXISTS +
// CREATE, re-GRANT) so the lock + grants are restored on every deploy.
//
// MUST run as the owner/migrate role (app_runtime cannot run DDL or GRANT).
// start.sh runs it after the push loop, before the app serves traffic.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(here, '..', 'drizzle');
const FILES = [
  '0027_app_runtime_role.sql',
  '0028_rls_tenant_policies.sql',
  '0029_users_self_rls.sql',
];

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[apply-rls] DATABASE_URL is required (must be the OWNER/migrate role)');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const file of FILES) {
    const sql = await fs.readFile(path.join(drizzleDir, file), 'utf8');
    console.log(`[apply-rls] applying ${file}`);
    await client.query(sql);
  }
  console.log('[apply-rls] done — RLS role, policies, and grants are in place');
} finally {
  await client.end();
}
