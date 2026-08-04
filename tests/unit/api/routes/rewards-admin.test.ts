import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rewardsRouter } from '../../../../apps/api/src/routes/rewards.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-483: parents manage the reward-shop catalogue: POST/PATCH/DELETE
// /api/rewards[/:id]. Admin-only, tenant-scoped: same guard chain as
// apps/api/src/routes/admin.ts (auth → tenant context → member → admin).
// DELETE is a soft-delete (archived_at), never a hard DELETE. Real Postgres
// tenant-isolation + soft-delete-survives-FK coverage lives in the
// integration spec (rewards-admin.feature).

const dbMock = { select: vi.fn(), insert: vi.fn(), update: vi.fn() };
vi.mock('../../../../apps/api/src/db/client.js', () => ({ getDb: () => dbMock }));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const REWARD_ID = '33333333-3333-4333-8333-333333333333';
const CALLER_MEMBER_ID = '55555555-5555-4555-8555-555555555555';
const FIXED_USER: User = {
  id: USER_ID,
  email: 's@e.com',
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
  updatedAt: new Date('2026-05-01T00:00:00.000Z'),
};

const REWARD_ROW = {
  id: REWARD_ID,
  tenantId: TENANT_ID,
  name: 'Movie night',
  description: 'Pick the family film',
  stickerCost: 20,
  icon: '🎬',
  archivedAt: null,
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: new Date('2026-06-01T00:00:00.000Z'),
};

interface SeedOpts {
  noTenant?: boolean;
  /** null = caller is not a tenant member at all. */
  callerRole?: string | null;
  insertReturns?: unknown[];
  updateReturns?: unknown[];
}

function buildApp(opts: SeedOpts = {}) {
  const { noTenant = false, callerRole = 'admin', insertReturns = [], updateReturns = [] } = opts;
  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: 's@e.com', claims: {} });
    c.set('userRow', FIXED_USER);
    c.set('tenantId', noTenant ? undefined : TENANT_ID);
    await next();
  };

  dbMock.select.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: () =>
          Promise.resolve(
            callerRole ? [{ id: CALLER_MEMBER_ID, role: callerRole }] : ([] as unknown[]),
          ),
      }),
    }),
  }));

  dbMock.insert.mockImplementation(() => ({
    values: () => ({ returning: () => Promise.resolve(insertReturns) }),
  }));

  let lastSetPatch: Record<string, unknown> | undefined;
  const updateWhere = vi.fn(() => ({ returning: () => Promise.resolve(updateReturns) }));
  dbMock.update.mockImplementation(() => ({
    set: (patch: Record<string, unknown>) => {
      lastSetPatch = patch;
      return { where: updateWhere };
    },
  }));

  const app = new Hono();
  app.use('*', seed);
  app.route('/api/rewards', rewardsRouter);
  return { app, updateWhere, getLastSetPatch: () => lastSetPatch };
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
  dbMock.update.mockReset();
});

function postJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function patchJson(body: unknown): RequestInit {
  return {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('FHS-483: POST /api/rewards (create)', () => {
  it('400 when no tenant context', async () => {
    const { app } = buildApp({ noTenant: true });
    const res = await app.request(
      '/api/rewards',
      postJson({ name: 'Movie night', stickerCost: 20 }),
    );
    expect(res.status).toBe(400);
  });

  it('403 when the caller is not a tenant member', async () => {
    const { app } = buildApp({ callerRole: null });
    const res = await app.request(
      '/api/rewards',
      postJson({ name: 'Movie night', stickerCost: 20 }),
    );
    expect(res.status).toBe(403);
  });

  it('403 ADMIN_ONLY for a non-admin member (adult)', async () => {
    const { app } = buildApp({ callerRole: 'adult' });
    const res = await app.request(
      '/api/rewards',
      postJson({ name: 'Movie night', stickerCost: 20 }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { errorCode: string }).errorCode).toBe('ADMIN_ONLY');
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('400 when name is missing', async () => {
    const { app } = buildApp();
    const res = await app.request('/api/rewards', postJson({ stickerCost: 20 }));
    expect(res.status).toBe(400);
  });

  it('400 when stickerCost is below 1', async () => {
    const { app } = buildApp();
    const res = await app.request(
      '/api/rewards',
      postJson({ name: 'Movie night', stickerCost: 0 }),
    );
    expect(res.status).toBe(400);
  });

  it('201 for an admin: creates the reward scoped to the caller tenant', async () => {
    const { app } = buildApp({ insertReturns: [REWARD_ROW] });
    const res = await app.request(
      '/api/rewards',
      postJson({ name: 'Movie night', description: 'Pick the film', stickerCost: 20, icon: '🎬' }),
    );
    expect(res.status).toBe(201);
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { id: string; name: string; stickerCost: number };
    expect(body).toEqual({
      id: REWARD_ID,
      name: 'Movie night',
      description: 'Pick the family film',
      stickerCost: 20,
      icon: '🎬',
    });
  });
});

describe('FHS-483: PATCH /api/rewards/:id (update)', () => {
  it('400 for a malformed reward id', async () => {
    const { app } = buildApp();
    const res = await app.request('/api/rewards/not-a-uuid', patchJson({ name: 'New name' }));
    expect(res.status).toBe(400);
  });

  it('403 when the caller is not a tenant member', async () => {
    const { app } = buildApp({ callerRole: null });
    const res = await app.request(`/api/rewards/${REWARD_ID}`, patchJson({ name: 'New name' }));
    expect(res.status).toBe(403);
  });

  it('403 ADMIN_ONLY for a non-admin member', async () => {
    const { app } = buildApp({ callerRole: 'child' });
    const res = await app.request(`/api/rewards/${REWARD_ID}`, patchJson({ name: 'New name' }));
    expect(res.status).toBe(403);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('400 when stickerCost is not a positive integer', async () => {
    const { app } = buildApp();
    const res = await app.request(`/api/rewards/${REWARD_ID}`, patchJson({ stickerCost: -1 }));
    expect(res.status).toBe(400);
  });

  it('404 when the reward is not in the caller tenant', async () => {
    const { app } = buildApp({ updateReturns: [] });
    const res = await app.request(`/api/rewards/${REWARD_ID}`, patchJson({ name: 'New name' }));
    expect(res.status).toBe(404);
  });

  it('200 for an admin: only supplied fields are patched', async () => {
    const { app, getLastSetPatch } = buildApp({
      updateReturns: [{ ...REWARD_ROW, stickerCost: 30 }],
    });
    const res = await app.request(`/api/rewards/${REWARD_ID}`, patchJson({ stickerCost: 30 }));
    expect(res.status).toBe(200);
    const patch = getLastSetPatch();
    expect(patch?.stickerCost).toBe(30);
    expect(patch?.name).toBeUndefined();
    const body = (await res.json()) as { stickerCost: number };
    expect(body.stickerCost).toBe(30);
  });

  it('200: an explicit null clears an optional field', async () => {
    const { app, getLastSetPatch } = buildApp({
      updateReturns: [{ ...REWARD_ROW, description: null }],
    });
    const res = await app.request(`/api/rewards/${REWARD_ID}`, patchJson({ description: null }));
    expect(res.status).toBe(200);
    expect(getLastSetPatch()?.description).toBeNull();
  });
});

describe('FHS-483: DELETE /api/rewards/:id (archive)', () => {
  it('400 for a malformed reward id', async () => {
    const { app } = buildApp();
    const res = await app.request('/api/rewards/not-a-uuid', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('403 when the caller is not a tenant member', async () => {
    const { app } = buildApp({ callerRole: null });
    const res = await app.request(`/api/rewards/${REWARD_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('403 ADMIN_ONLY for a non-admin member', async () => {
    const { app } = buildApp({ callerRole: 'teen' });
    const res = await app.request(`/api/rewards/${REWARD_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('404 when the reward is not in the caller tenant (or already archived)', async () => {
    const { app } = buildApp({ updateReturns: [] });
    const res = await app.request(`/api/rewards/${REWARD_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('204 for an admin: soft-deletes via archived_at, not a hard delete', async () => {
    const { app, getLastSetPatch } = buildApp({ updateReturns: [{ id: REWARD_ID }] });
    const res = await app.request(`/api/rewards/${REWARD_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(getLastSetPatch()?.archivedAt).toBeInstanceOf(Date);
  });
});
