// Re-export the test DB client from @familyhub/test-utils so spec files
// have one canonical import path. Same pool — instantiated lazily, max 2
// connections, idle_timeout 5s, separate from the prod pool.

export { getTestDb, closeTestDb } from '@familyhub/test-utils';
