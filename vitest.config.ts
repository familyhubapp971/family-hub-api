import { defineConfig } from 'vitest/config';

// Unit tests for the server, the shared rules and the test helpers.
// Integration tests have their own config: tests/integration/vitest.config.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/unit/api/**/*.{test,spec}.{ts,tsx}',
      'tests/unit/shared/**/*.{test,spec}.ts',
      'tests/helpers/src/**/*.{test,spec}.ts',
    ],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: [
        'src/**/*.{ts,tsx}',
        'shared-rules/src/**/*.{ts,tsx}',
        'tests/helpers/src/**/*.{ts,tsx}',
      ],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.test.{ts,tsx}',
        '**/*.spec.{ts,tsx}',
        '**/*.d.ts',
      ],
      all: true,
    },
  },
});
