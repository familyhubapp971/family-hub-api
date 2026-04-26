import { describe, it, expect } from 'vitest';
import { withTenant, currentTenantId, setTenantOnTransaction } from './withTenant.js';

describe('withTenant + currentTenantId', () => {
  it('returns undefined outside any scope', () => {
    expect(currentTenantId()).toBeUndefined();
  });

  it('exposes the tenantId inside the scope', async () => {
    await withTenant('acme-tenant', async () => {
      expect(currentTenantId()).toBe('acme-tenant');
    });
  });

  it('isolates concurrent scopes', async () => {
    const seen: string[] = [];
    await Promise.all([
      withTenant('tenant-a', async () => {
        await Promise.resolve();
        seen.push(currentTenantId() ?? 'none');
      }),
      withTenant('tenant-b', async () => {
        await Promise.resolve();
        seen.push(currentTenantId() ?? 'none');
      }),
    ]);
    expect(seen.sort()).toEqual(['tenant-a', 'tenant-b']);
  });
});

describe('setTenantOnTransaction', () => {
  it('issues a SET LOCAL statement on the supplied tx', async () => {
    const calls: string[] = [];
    const tx = { execute: async (sql: string) => calls.push(sql) };
    await setTenantOnTransaction(tx, '11111111-2222-3333-4444-555555555555');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('SET LOCAL app.tenant_id');
    expect(calls[0]).toContain('11111111-2222-3333-4444-555555555555');
  });

  it('rejects unsafe tenant ids (no SQL injection seam)', async () => {
    const tx = { execute: async () => undefined };
    await expect(setTenantOnTransaction(tx, "'; DROP TABLE users; --")).rejects.toThrow(/must be a UUID/);
  });

  it('rejects non-UUID strings even if they look slug-safe', async () => {
    const tx = { execute: async () => undefined };
    await expect(setTenantOnTransaction(tx, 'acme')).rejects.toThrow(/must be a UUID/);
    await expect(setTenantOnTransaction(tx, '1')).rejects.toThrow(/must be a UUID/);
  });
});
