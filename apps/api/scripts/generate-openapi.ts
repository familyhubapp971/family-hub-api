// FHS-356: regenerate apps/api/openapi.json from the live route table.
// Run via `pnpm -F api openapi:generate`. Commit the result in the same PR as
// any API change (enforced by the CI staleness gate + the pre-merge checklist).
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { buildOpenApiSpec } from '../src/openapi/build-spec.js';
import { buildPostmanFiles } from '../src/openapi/build-postman.js';

const spec = buildOpenApiSpec(buildApp());
const out = new URL('../openapi.json', import.meta.url);
writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
console.log(`openapi.json: ${Object.keys(spec.paths).length} paths written.`);

// FHS-664: the Postman collection + environments are built from the same spec.
const postmanDir = new URL('../postman/', import.meta.url);
mkdirSync(postmanDir, { recursive: true });
for (const [name, body] of Object.entries(buildPostmanFiles(spec))) {
  writeFileSync(new URL(name, postmanDir), body);
}
console.log('postman/: collection and environments written.');

// FHS-665: also refresh the founder's local, gitignored copy in documents/.
const sharedDir = new URL('../../../documents/postman/', import.meta.url);
mkdirSync(sharedDir, { recursive: true });
for (const [name, body] of Object.entries(buildPostmanFiles(spec))) {
  writeFileSync(new URL(name, sharedDir), body);
}
console.log('documents/postman/: local copy refreshed.');
