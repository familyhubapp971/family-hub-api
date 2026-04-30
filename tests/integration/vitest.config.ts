import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Integration tier — DELIBERATELY separate from the unit Vitest workspace.
// Run via `pnpm test:integration` (not via the root `pnpm test` workspace
// runner); requires Postgres on port 5433 (docker-compose.test.yml).

const ROOT = path.resolve(__dirname, '..', '..');

export default defineConfig({
  // Anchor relative paths to THIS config file's directory, not the
  // CWD where `pnpm test:integration` was invoked.
  root: __dirname,
  test: {
    environment: 'node',
    // Two roots during the migration to BDD/Cucumber (FHS-218):
    //  - specs/**/*.spec.ts — legacy Vitest specs, kept while coverage
    //    is being migrated. Removed once each spec's scenarios live in
    //    a corresponding tests/integration/features/<slug>.feature.
    //  - steps/**/*.steps.ts — Cucumber step files powered by
    //    @amiceli/vitest-cucumber, loading .feature files from
    //    tests/integration/features/.
    include: ['specs/**/*.spec.ts', 'steps/**/*.steps.ts'],
    globalSetup: './support/global-setup.ts',
    setupFiles: ['./support/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run sequentially by default — integration specs share the test DB
    // and currently rely on per-test transaction rollback. Concurrent
    // specs would have to scope to per-spec schemas; defer until needed.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: {
    alias: {
      '@familyhub/test-utils': path.join(ROOT, 'packages/test-utils/src/index.ts'),
      '@familyhub/api/app': path.join(ROOT, 'apps/api/src/app.ts'),
      '@familyhub/api/middleware/auth': path.join(ROOT, 'apps/api/src/middleware/auth.ts'),
    },
  },
});
