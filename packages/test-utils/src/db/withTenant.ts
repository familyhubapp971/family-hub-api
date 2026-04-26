import { AsyncLocalStorage } from 'node:async_hooks';

// Mirror of the prod tenant middleware (apps/api/src/middleware/tenant.ts —
// landing in FHS-12). Per ADR 0001, every tenant-scoped query runs inside
// an AsyncLocalStorage scope that sets `app.tenant_id` on the connection;
// RLS policies then filter at the storage layer.
//
// In tests:
//   await withTenant('tenant-uuid', async () => {
//     const rows = await db.select().from(habits); // RLS-filtered
//   });
//
// Outside any scope, `currentTenantId()` returns undefined and queries
// against tenant-scoped tables will return zero rows under RLS — that is
// the expected behaviour and the integration test's "tenant isolation"
// scenarios rely on it.

const storage = new AsyncLocalStorage<{ tenantId: string }>();

export function currentTenantId(): string | undefined {
  return storage.getStore()?.tenantId;
}

export async function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ tenantId }, fn);
}

// Drizzle helper — set the GUC on a specific transaction client.
// Integration specs typically wrap each test in db.transaction(...) and
// call this at the top so RLS policies see the tenant for the rest of
// the transaction.
//
// Usage:
//   await db.transaction(async (tx) => {
//     await setTenantOnTransaction(tx, tenantId);
//     // ... queries here run as tenantId
//   });
export async function setTenantOnTransaction(
  tx: { execute: (sql: string) => Promise<unknown> },
  tenantId: string,
): Promise<void> {
  // Use SET LOCAL so the setting auto-clears at transaction end.
  // SET LOCAL cannot bind parameters, so we interpolate — but ONLY
  // accept canonical UUIDs (the prod tenant id type per ADR 0001).
  // Slugs are resolved to UUIDs by the tenant middleware before
  // reaching this function; never call this with a slug.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw new Error(`setTenantOnTransaction: tenantId must be a UUID, got "${tenantId}"`);
  }
  await tx.execute(`SET LOCAL app.tenant_id = '${tenantId}'`);
}
