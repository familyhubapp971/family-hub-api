// FHS-356: CI staleness gate. Fails if openapi.json doesn't match the live
// routes, forcing `pnpm -F api openapi:generate` to be run + committed.
import { readFileSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { buildOpenApiSpec, findUndocumented } from '../src/openapi/build-spec.js';
import { buildPostmanFiles } from '../src/openapi/build-postman.js';

const spec = buildOpenApiSpec(buildApp());
const generated = JSON.stringify(spec, null, 2) + '\n';
let committed = '';
try {
  committed = readFileSync(new URL('../openapi.json', import.meta.url), 'utf8');
} catch {
  console.error('openapi.json is missing: run `pnpm -F api openapi:generate` and commit it.');
  process.exit(1);
}
if (generated !== committed) {
  console.error(
    'openapi.json is out of date with the API routes.\n' +
      'Run `pnpm -F api openapi:generate` and commit the result.',
  );
  process.exit(1);
}
// FHS-664: the Postman files must match the spec too.
for (const [name, body] of Object.entries(buildPostmanFiles(spec))) {
  let onDisk = '';
  try {
    onDisk = readFileSync(new URL(`../postman/${name}`, import.meta.url), 'utf8');
  } catch {
    // reported below as stale
  }
  if (onDisk !== body) {
    console.error(
      `postman/${name} is out of date with the API.\n` +
        'Run `pnpm -F api openapi:generate` and commit the result.',
    );
    process.exit(1);
  }
}

// FHS-664: a route that is mounted but not fully described fails the build.
const gaps = findUndocumented(buildApp());
if (gaps.length) {
  console.error(
    `${gaps.length} endpoint(s) lack full docs in apps/api/src/openapi (registry.ts or meta/):\n` +
      gaps.map((g) => `  - ${g}`).join('\n'),
  );
  process.exit(1);
}
console.log('openapi.json is up to date.');
