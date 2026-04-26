import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Centralized tests directory per CLAUDE.md.
    include: ['../../tests/unit/api/**/*.{test,spec}.{ts,tsx}'],
    passWithNoTests: true,
  },
});
