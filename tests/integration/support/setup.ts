// Per-file setup — runs in every spec file. Closes the test DB pool
// after the suite so vitest --watch doesn't hang on lingering
// connections (per the test-utils README requirement).

import { afterAll } from 'vitest';
import { closeTestDb } from '@familyhub/test-utils';

afterAll(async () => {
  await closeTestDb();
});
