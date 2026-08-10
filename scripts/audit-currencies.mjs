/**
 * FHS-636: list any family sitting on a currency the sticker economy cannot
 * show correctly.
 *
 * Read-only. It runs one SELECT and writes nothing, so it is safe to point at
 * staging or production.
 *
 * Why it exists: FHS-636 stopped the api ACCEPTING a 0- or 3-decimal currency,
 * but a row that already held one would keep rendering every amount a hundred
 * times too small, quietly. The picker has refused these since FHS-515, so the
 * expected answer is "none". Run it rather than assume it.
 *
 * Usage:
 *   set -a; source .env.local; set +a
 *   node scripts/audit-currencies.mjs
 */
/* eslint-disable no-console -- a command-line audit whose whole job is to print
   what it found; there is no other output channel. */
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required (read-only; point it wherever you want checked)');
  process.exit(1);
}

function decimals(code) {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rows } = await client.query(
    'SELECT slug, name, currency FROM tenants ORDER BY created_at',
  );
  const bad = rows.filter((r) => decimals(r.currency) !== 2);

  console.log(`checked ${rows.length} famil${rows.length === 1 ? 'y' : 'ies'}`);
  if (bad.length === 0) {
    console.log('  every one is on a currency the app can show correctly');
  } else {
    console.log(`  ${bad.length} on an unsupported currency:`);
    for (const r of bad) {
      console.log(`    ${r.slug}  ${r.currency}  (${decimals(r.currency)} decimals)  ${r.name}`);
    }
    console.log(
      '\n  Every amount on those families reads 100x wrong. Decide what to move them to.',
    );
    process.exitCode = 1;
  }
} finally {
  await client.end();
}
