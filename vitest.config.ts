import { defineConfig } from 'vitest/config';

// Root-level coverage defaults. Per-package config overrides environment
// (jsdom for web, node for api/shared) and keeps test paths scoped.
// Re-run with `pnpm test:coverage` to collect a merged lcov report.
export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: [
        'apps/*/src/**/*.{ts,tsx}',
        'packages/*/src/**/*.{ts,tsx}',
      ],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.test.{ts,tsx}',
        '**/*.spec.{ts,tsx}',
        '**/*.d.ts',
        'apps/*/vite.config.ts',
        'apps/*/drizzle.config.ts',
        'apps/*/postcss.config.js',
        'apps/*/tailwind.config.js',
        'apps/*/src/main.tsx',
      ],
      all: true,
    },
  },
});
