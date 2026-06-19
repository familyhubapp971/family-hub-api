// FHS-356 — CI staleness gate. Fails if openapi.json doesn't match the live
// routes, forcing `pnpm -F api openapi:generate` to be run + committed.
import { readFileSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { buildOpenApiSpec } from '../src/openapi/build-spec.js';

const generated = JSON.stringify(buildOpenApiSpec(buildApp()), null, 2) + '\n';
let committed = '';
try {
  committed = readFileSync(new URL('../openapi.json', import.meta.url), 'utf8');
} catch {
  console.error('openapi.json is missing — run `pnpm -F api openapi:generate` and commit it.');
  process.exit(1);
}
if (generated !== committed) {
  console.error(
    'openapi.json is out of date with the API routes.\n' +
      'Run `pnpm -F api openapi:generate` and commit the result.',
  );
  process.exit(1);
}
console.log('openapi.json is up to date.');
