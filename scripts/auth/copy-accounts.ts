// FHS-699: copy accounts and their sign-in links (Google etc.) from Supabase
// into our own GoTrue database, keeping every id. Reads Supabase through its
// admin API (read only), one account at a time, because its account list
// leaves the links out (FHS-705); writes auth.users and auth.identities in one
// transaction. Prints counts and checks only, never email addresses.
//
// Usage (dry run first, then --apply):
//   SOURCE_SUPABASE_URL=https://<ref>.supabase.co \
//   SOURCE_SUPABASE_SERVICE_ROLE_KEY=... \
//   TARGET_DATABASE_URL=postgres://... \
//   pnpm tsx scripts/auth/copy-accounts.ts [--apply] [--app-ids <file>]
//
// --source-file <file>: read accounts from a JSON file shaped like Supabase's
// admin reply ({ "users": [...] }) instead of calling Supabase. Used to
// rehearse with made-up accounts, so no real person's data is needed.
//
// --app-ids: a file of app users.id values (one per line, from our own
// database). The run fails if any of them has no account to copy, because
// that person could not sign in after the switch.
//
// NEVER point TARGET_DATABASE_URL at staging with production accounts: real
// people's emails must not land in staging.

import { readFileSync } from 'node:fs';
import pg from 'pg';
import {
  IDENTITY_COLUMNS,
  USER_COLUMNS,
  identitiesByProvider,
  identityRows,
  missingIds,
  userRow,
  usersWithoutLinks,
  type SourceUser,
} from '../../src/security/account-copy.js';
import { readSourceAccounts } from '../../src/security/account-copy-source.js';

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return v;
}

function placeholders(rows: number, cols: number): string {
  return Array.from(
    { length: rows },
    (_, r) => `(${Array.from({ length: cols }, (_, c) => `$${r * cols + c + 1}`).join(',')})`,
  ).join(',');
}

async function main() {
  const apply = process.argv.includes('--apply');
  const appIdsArg = process.argv.indexOf('--app-ids');
  const fileArg = process.argv.indexOf('--source-file');

  let users: SourceUser[];
  if (fileArg !== -1) {
    const file = process.argv[fileArg + 1];
    if (!file) throw new Error('--source-file needs a file');
    users = (JSON.parse(readFileSync(file, 'utf8')) as { users: SourceUser[] }).users;
  } else {
    const source = need('SOURCE_SUPABASE_URL').replace(/\/+$/, '');
    users = await readSourceAccounts(source, need('SOURCE_SUPABASE_SERVICE_ROLE_KEY'));
  }
  const sourceIds = users.map((u) => u.id);
  const byProvider = identitiesByProvider(users);
  console.warn(`source: ${users.length} accounts, sign-in links ${JSON.stringify(byProvider)}`);

  // FHS-705: an account with no sign-in link could not be signed in to after
  // the copy. Seeing one most likely means the links were not read at all.
  const noLinks = usersWithoutLinks(users);
  if (noLinks.length > 0) {
    console.error(`stop: ${noLinks.length} accounts have no sign-in link`);
    process.exit(1);
  }

  if (appIdsArg !== -1) {
    const file = process.argv[appIdsArg + 1];
    if (!file) throw new Error('--app-ids needs a file');
    const appIds = readFileSync(file, 'utf8').split(/\s+/).filter(Boolean);
    const missing = missingIds(appIds, sourceIds);
    console.warn(
      `app accounts: ${appIds.length}, with a matching sign-in account: ${appIds.length - missing.length}, missing: ${missing.length}`,
    );
    if (missing.length > 0) {
      console.error('stop: some app accounts have no sign-in account to copy');
      process.exit(1);
    }
  }

  if (!apply) {
    console.warn('dry run: nothing written (add --apply)');
    return;
  }

  const client = new pg.Client({ connectionString: need('TARGET_DATABASE_URL') });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < users.length; i += 200) {
      const chunk = users.slice(i, i + 200);
      await client.query(
        `INSERT INTO auth.users (${USER_COLUMNS.join(',')}) VALUES ${placeholders(chunk.length, USER_COLUMNS.length)} ON CONFLICT (id) DO NOTHING`,
        chunk.flatMap(userRow),
      );
      const ids = chunk.flatMap(identityRows);
      if (ids.length > 0) {
        await client.query(
          `INSERT INTO auth.identities (${IDENTITY_COLUMNS.join(',')}) VALUES ${placeholders(ids.length, IDENTITY_COLUMNS.length)} ON CONFLICT (provider_id, provider) DO NOTHING`,
          ids.flat(),
        );
      }
    }

    // Checks, inside the transaction: undo everything if any fails.
    const copied = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM auth.users WHERE id = ANY($1::uuid[])',
      [sourceIds],
    );
    const links = await client.query<{ provider: string; n: string }>(
      'SELECT provider, count(*)::text AS n FROM auth.identities WHERE user_id = ANY($1::uuid[]) GROUP BY provider',
      [sourceIds],
    );
    const targetByProvider = Object.fromEntries(links.rows.map((r) => [r.provider, Number(r.n)]));
    const okUsers = Number(copied.rows[0]?.n) === users.length;
    const okLinks =
      JSON.stringify(sortKeys(targetByProvider)) === JSON.stringify(sortKeys(byProvider));
    console.warn(
      `target: ${copied.rows[0]?.n} of ${users.length} accounts with the same id, sign-in links ${JSON.stringify(targetByProvider)}`,
    );
    if (!okUsers || !okLinks) {
      await client.query('ROLLBACK');
      console.error('stop: counts do not match, nothing written');
      process.exit(1);
    }
    await client.query('COMMIT');
    console.warn('copied: counts match');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

function sortKeys(o: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
