import { defineWorkspace } from 'vitest/config';

// Single workspace entry so `pnpm vitest run --coverage` at the repo
// root discovers every package's tests and rolls coverage up into one
// report under /coverage. Per-package `pnpm --filter <pkg> test`
// still works — vitest picks up each package's own config.
export default defineWorkspace([
  'packages/shared',
  'apps/api',
  'apps/web',
]);
