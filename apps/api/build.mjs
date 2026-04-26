// Why we bundle instead of using `tsc` directly:
//
// `packages/shared/package.json` exports raw .ts source (`"main": "./src/index.ts"`)
// so that dev (tsx watch), tests (vitest) and typecheck consume the workspace dep
// without a build step. The trade-off: when api's tsc compiles, the
// `@familyhub/*: packages/*/src` path alias in tsconfig.base.json pulls shared's
// .ts files into the program graph, widening rootDir to the longest common path
// (the repo root). tsc then emits to apps/api/dist/apps/api/src/index.js, and
// `node dist/index.js` (Railway's start command) fails with MODULE_NOT_FOUND.
//
// Fix: bundle api with esbuild for production. Workspace deps get inlined into a
// single dist/index.js; real npm packages stay external and are loaded from
// node_modules at runtime. Typecheck remains the responsibility of `tsc --noEmit`.

import { build } from 'esbuild';

// Externalize every bare specifier EXCEPT @familyhub/* workspace packages. If we
// ever add another path alias in tsconfig.base.json, add it to the allow-list
// below or it will be wrongly externalized at runtime.
const externalizeNodeModules = {
  name: 'externalize-node-modules',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('@familyhub/')) return null;
      return { path: args.path, external: true };
    });
  },
};

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Sourcemap kept until we ship to Sentry — gives readable stack traces in
  // Railway logs. dist/index.js is server-side only, never publicly served.
  sourcemap: true,
  logLevel: 'info',
  // pg / pino / drizzle internally call require() in some code paths.
  // Polyfill it for ESM output so they don't crash at runtime.
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  plugins: [externalizeNodeModules],
});
