import { describe, expect, it, vi } from 'vitest';

// FHS-351: the boot guard refuses to start the app when RLS enforcement is
// expected but the connected DB role can bypass RLS. Mock the root db so we can
// feed it different pg_roles rows without a real Postgres.

const execute = vi.fn();
vi.mock('../../../../apps/api/src/db/client.js', () => ({
  getRootDb: () => ({ execute }),
}));

import { assertRlsEnforceable } from '../../../../apps/api/src/lib/rls-boot-guard.js';

describe('FHS-351: RLS boot guard', () => {
  it('passes when the connected role cannot bypass RLS (app_runtime)', async () => {
    execute.mockResolvedValueOnce({
      rows: [{ rolname: 'app_runtime', rolbypassrls: false, rolsuper: false }],
    });
    await expect(assertRlsEnforceable()).resolves.toBeUndefined();
  });

  it('throws when the connected role has BYPASSRLS', async () => {
    execute.mockResolvedValueOnce({
      rows: [{ rolname: 'postgres', rolbypassrls: true, rolsuper: false }],
    });
    await expect(assertRlsEnforceable()).rejects.toThrow(/can bypass RLS/);
  });

  it('throws when the connected role is a superuser', async () => {
    execute.mockResolvedValueOnce({
      rows: [{ rolname: 'postgres', rolbypassrls: false, rolsuper: true }],
    });
    await expect(assertRlsEnforceable()).rejects.toThrow(/can bypass RLS/);
  });

  it('throws when the connected role cannot be read', async () => {
    execute.mockResolvedValueOnce({ rows: [] });
    await expect(assertRlsEnforceable()).rejects.toThrow(/could not read the connected role/);
  });
});
