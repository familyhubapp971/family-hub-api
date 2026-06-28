#!/usr/bin/env node
// Export all beta_feedback rows to a CSV spreadsheet.
//
//   pnpm feedback:export              # prints CSV to the screen
//   pnpm feedback:export out.csv      # writes CSV to out.csv
//
// Zero-install: uses the `pg` driver already in the repo and reads
// DATABASE_URL from .env.local (same place the app reads it).
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

// ── Load DATABASE_URL from .env.local (simple KEY=VALUE parse) ────────────────
try {
  const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {
  /* no .env.local — rely on the ambient environment */
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL not set (add it to .env.local).');
  process.exit(1);
}

const COLUMNS = [
  'family',
  'email',
  'pmf_disappointment',
  'recommend_score',
  'solves_problem',
  'ease_of_use',
  'keep_using',
  'pain_point',
  'feature_request',
  'other_feedback',
  'created_at',
];

function toCsv(rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [COLUMNS.join(',')];
  for (const r of rows) lines.push(COLUMNS.map((c) => esc(r[c])).join(','));
  return lines.join('\n') + '\n';
}

const client = new pg.Client({ connectionString });
await client.connect();
const { rows } = await client.query(
  `SELECT t.slug AS family,
          bf.submitted_by_email AS email,
          bf.pmf_disappointment,
          bf.recommend_score,
          bf.solves_problem,
          bf.ease_of_use,
          bf.keep_using,
          bf.pain_point,
          bf.feature_request,
          bf.other_feedback,
          bf.created_at
     FROM beta_feedback bf
     LEFT JOIN tenants t ON t.id = bf.tenant_id
    ORDER BY bf.created_at ASC`,
);
await client.end();

const csv = toCsv(rows);
const outPath = process.argv[2];
if (outPath) {
  writeFileSync(outPath, csv);
  console.error(`Wrote ${rows.length} feedback row(s) to ${outPath}`);
} else {
  process.stdout.write(csv);
}
