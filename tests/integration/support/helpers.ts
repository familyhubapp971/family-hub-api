// Convenience re-exports + integration-specific helpers. Spec files
// import from here so adding a new shared helper is a one-place change.

export {
  withTenant,
  setTenantOnTransaction,
  truncateAll,
  buildTenant,
  buildUser,
  buildFamily,
  makeRequest,
  mintTestJwt,
} from '@familyhub/test-utils';

export { getTestDb, closeTestDb } from './db.js';

// Per-test transaction wrapper. Begin a tx in beforeEach, roll back in
// afterEach — preserves sequences within a test and avoids the cost of
// truncating tables every spec. Once Sprint 1 (FHS-1) lands tables, the
// pattern is:
//
//   const ctx = makeTxContext();
//   beforeEach(async () => { await ctx.begin(); });
//   afterEach(async () => { await ctx.rollback(); });
//
// All spec queries within `ctx.tx` are isolated to the test.
//
// The implementation is a thin wrapper around Drizzle's transaction
// primitive. Today it's a stub awaiting FHS-1's schema; the surface
// is here so spec authors can write against it now.

export interface TxContext {
  begin(): Promise<void>;
  rollback(): Promise<void>;
}

export function makeTxContext(): TxContext {
  // Symmetric stub: both methods throw until FHS-1. An asymmetric stub
  // (begin throws, rollback no-ops) would mask "I forgot to call begin"
  // bugs because the afterEach silently succeeds.
  const notReady = () =>
    new Error(
      'makeTxContext requires Drizzle schema (FHS-1). ' +
        'Use raw db.execute() in scaffolding tests until then.',
    );
  return {
    async begin() {
      throw notReady();
    },
    async rollback() {
      throw notReady();
    },
  };
}
