#!/usr/bin/env node
// Export all feedback rows (in-app + public homepage) to a single CSV.
//
//   pnpm feedback:export              # prints CSV to the screen
//   pnpm feedback:export out.csv      # writes CSV to out.csv
//
// Sources:
//   beta_feedback  : authenticated in-app survey (source = 'in_app')
//                    or the per-screen form      (source = 'screen', FHS-670)
//   public_feedback: anonymous homepage survey  (source = 'public')
//
// Rows are grouped person by person, then visit by visit, oldest first, so one
// person's answers from one visit sit together. With an output file, a second
// file <name>-by-screen.csv sums the per-screen answers: how many, the average
// of each rating, and which features were mentioned most.
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
  /* no .env.local: rely on the ambient environment */
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL not set (add it to .env.local).');
  process.exit(1);
}

const COLUMNS = [
  'source',
  'family',
  'name',
  'email',
  'visit_id',
  'screen',
  'features',
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

// UNION of both tables ordered by creation time.
// beta_feedback rows carry the family slug (from the tenants join) and the
// submitted_by_email snapshot; public_feedback rows carry the visitor's name
// and email directly.
const { rows } = await client.query(
  `SELECT * FROM (
   SELECT CASE WHEN bf.screen IS NULL THEN 'in_app' ELSE 'screen' END AS source,
          t.slug                     AS family,
          NULL                       AS name,
          bf.submitted_by_email      AS email,
          bf.visit_id::text          AS visit_id,
          bf.screen,
          array_to_string(bf.features, '; ') AS features,
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

   UNION ALL

   SELECT 'public'                   AS source,
          NULL                       AS family,
          pf.name                    AS name,
          pf.email                   AS email,
          NULL                       AS visit_id,
          NULL                       AS screen,
          NULL                       AS features,
          pf.pmf_disappointment,
          pf.recommend_score,
          pf.solves_problem,
          pf.ease_of_use,
          pf.keep_using,
          pf.pain_point,
          pf.feature_request,
          pf.other_feedback,
          pf.created_at
     FROM public_feedback pf

   ) AS answers
   ORDER BY family NULLS LAST, email NULLS LAST,
            min(created_at) OVER (PARTITION BY visit_id) NULLS LAST, visit_id NULLS LAST,
            created_at ASC`,
);
await client.end();

// FHS-670: one line per screen, busiest first.
function byScreen(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!r.screen) continue;
    const g = groups.get(r.screen) ?? { answers: 0, people: new Set(), ratings: {}, features: {} };
    g.answers += 1;
    if (r.email) g.people.add(r.email);
    for (const k of ['solves_problem', 'ease_of_use', 'keep_using']) {
      if (r[k] === null || r[k] === undefined) continue;
      (g.ratings[k] ??= []).push(Number(r[k]));
    }
    for (const f of r.features ? r.features.split('; ') : []) {
      g.features[f] = (g.features[f] ?? 0) + 1;
    }
    groups.set(r.screen, g);
  }
  const avg = (xs) => (xs?.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : '');
  const esc = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [
    'screen,answers,people,avg_solves_problem,avg_ease_of_use,avg_keep_using,features_mentioned',
  ];
  for (const [screen, g] of [...groups].sort((a, b) => b[1].answers - a[1].answers)) {
    const top = Object.entries(g.features)
      .sort((a, b) => b[1] - a[1])
      .map(([f, n]) => `${f} (${n})`)
      .join('; ');
    lines.push(
      [
        screen,
        g.answers,
        g.people.size,
        avg(g.ratings.solves_problem),
        avg(g.ratings.ease_of_use),
        avg(g.ratings.keep_using),
        esc(top),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

const csv = toCsv(rows);
const outPath = process.argv[2];
if (outPath) {
  writeFileSync(outPath, csv);
  console.error(`Wrote ${rows.length} feedback row(s) to ${outPath}`);
  const summaryPath = outPath.replace(/(\.csv)?$/, '-by-screen.csv');
  writeFileSync(summaryPath, byScreen(rows));
  console.error(`Wrote the per-screen summary to ${summaryPath}`);
} else {
  process.stdout.write(csv);
}
