// FHS-356 — regenerate apps/api/openapi.json from the live route table.
// Run via `pnpm -F api openapi:generate`. Commit the result in the same PR as
// any API change (enforced by the CI staleness gate + the pre-merge checklist).
import { writeFileSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { buildOpenApiSpec } from '../src/openapi/build-spec.js';

const spec = buildOpenApiSpec(buildApp());
const out = new URL('../openapi.json', import.meta.url);
writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
console.log(`openapi.json: ${Object.keys(spec.paths).length} paths written.`);
