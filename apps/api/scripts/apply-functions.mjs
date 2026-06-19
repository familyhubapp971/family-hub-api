#!/usr/bin/env node
// FHS-357 — create the SECURITY DEFINER reader functions on every boot.
//
// Why this exists: staging/prod boot with `drizzle-kit push --force`, which
// diffs schema.ts and knows nothing about functions — so it never creates the
// 0030 functions (app_user_memberships, app_claimable_invitations). But the app
// CALLS those functions regardless of the RLS flip (GET /api/me + invite-claim),
// so they must exist on every deploy. This is separate from apply-rls.mjs (which
// is gated by APPLY_RLS because enabling RLS pre-flip would break the owner) —
// these functions are harmless pre-flip and must always be present.
//
// Every statement is idempotent (CREATE OR REPLACE FUNCTION, REVOKE, guarded
// GRANT). MUST run as the owner/migrate role.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(here, '..', 'drizzle');
const FILES = ['0030_rls_read_path_functions.sql'];

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[apply-functions] DATABASE_URL is required (must be the OWNER/migrate role)');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const file of FILES) {
    const sql = await fs.readFile(path.join(drizzleDir, file), 'utf8');
    console.log(`[apply-functions] applying ${file}`);
    await client.query(sql);
  }
  console.log('[apply-functions] done — reader functions are in place');
} finally {
  await client.end();
}
