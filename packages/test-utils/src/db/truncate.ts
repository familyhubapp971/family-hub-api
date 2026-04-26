// truncateAll(db) — wipe every tenant-scoped table between tests.
//
// Per ADR 0001, the prod schema (FHS-1+) carries `tenant_id` on every
// tenant-scoped table. This helper TRUNCATEs them all in one statement
// with RESTART IDENTITY CASCADE so sequences reset and FK chains are
// honoured.
//
// Today, no tenant-scoped tables exist yet (Sprint 1 lands the schema).
// truncateAll is therefore a no-op until the table list below is
// populated. Integration specs that import it will work as expected
// once the schema arrives — no spec rewrite needed.

const TENANT_SCOPED_TABLES: readonly string[] = [
  // populate as Sprint 1 (FHS-1+) lands tables, e.g.:
  // 'savings_transactions',
  // 'transaction_stickers',
  // 'habit_stickers',
  // 'habits',
  // 'weeks',
  // 'savings',
  // 'tenants', // last — others FK to it
];

export async function truncateAll(db: {
  execute: (sql: string) => Promise<unknown>;
}): Promise<void> {
  if (TENANT_SCOPED_TABLES.length === 0) return;
  const list = TENANT_SCOPED_TABLES.join(', ');
  await db.execute(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
