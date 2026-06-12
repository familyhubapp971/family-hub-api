import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invitationClaimRouter } from '../../../../apps/api/src/routes/invitations.js';
import { members, pendingInvitations } from '../../../../apps/api/src/db/schema.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-275 — POST /api/invitations/claim. The invited parent signs in
// for the first time; pending invitations addressed to their email
// link their login to the wizard-created member seat.

const dbMock = { select: vi.fn(), update: vi.fn(), insert: vi.fn() };
vi.mock('../../../../apps/api/src/db/client.js', () => ({
  getDb: () => dbMock,
}));

const USER_ID = '00000000-0000-4000-8000-000000000888';
const FIXED_USER: User = {
  id: USER_ID,
  email: 'yusuf@example.com',
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  updatedAt: new Date('2026-06-01T00:00:00.000Z'),
};
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const INVITE_ID = '33333333-3333-4333-8333-333333333333';

function chain(rows: unknown): unknown {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    limit: () => obj,
    set: () => obj,
    values: () => obj,
    returning: () => Promise.resolve(rows),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej),
  };
  return obj;
}

function buildApp(opts: {
  invites?: unknown[];
  memberClaimRows?: unknown[]; // what update(members).returning resolves to
}) {
  dbMock.select.mockImplementation(() => {
    // 1st select = pending invitations; later selects = tenant slug.
    if (dbMock.select.mock.calls.length === 1) return chain(opts.invites ?? []);
    return chain([{ slug: 'khans' }]);
  });
  const updatedTables: unknown[] = [];
  dbMock.update.mockImplementation((table: unknown) => {
    updatedTables.push(table);
    // update(members) → claim returning; update(pendingInvitations) →
    // the flip-first guard returns the flipped row (FHS-276 race fix).
    return chain(table === members ? (opts.memberClaimRows ?? []) : [{ id: INVITE_ID }]);
  });
  const insertedTables: unknown[] = [];
  dbMock.insert.mockImplementation((table: unknown) => {
    insertedTables.push(table);
    return chain([{ id: MEMBER_ID }]);
  });

  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: FIXED_USER.email, claims: {} });
    c.set('userRow', FIXED_USER);
    await next();
  };
  const app = new Hono();
  app.use('*', seed);
  app.route('/api/invitations/claim', invitationClaimRouter);
  return { app, updatedTables, insertedTables };
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.update.mockReset();
  dbMock.insert.mockReset();
});

describe('FHS-275 — POST /api/invitations/claim', () => {
  it('claims a linked seat: sets user_id, flips status, returns the slug', async () => {
    const { app, updatedTables } = buildApp({
      invites: [{ id: INVITE_ID, tenantId: TENANT_ID, memberId: MEMBER_ID }],
      memberClaimRows: [{ id: MEMBER_ID }],
    });
    const res = await app.request('/api/invitations/claim', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { claimed: Array<{ tenantId: string; slug: string }> };
    expect(body.claimed).toEqual([{ tenantId: TENANT_ID, slug: 'khans' }]);
    expect(updatedTables).toContain(members);
    expect(updatedTables).toContain(pendingInvitations);
  });

  it('returns empty when there is no pending invitation for the email', async () => {
    const { app, updatedTables } = buildApp({ invites: [] });
    const res = await app.request('/api/invitations/claim', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { claimed: unknown[] }).claimed).toEqual([]);
    expect(updatedTables).toHaveLength(0);
  });

  it('skips an invite whose seat is already claimed (update matches 0 rows)', async () => {
    const { app, updatedTables } = buildApp({
      invites: [{ id: INVITE_ID, tenantId: TENANT_ID, memberId: MEMBER_ID }],
      memberClaimRows: [], // seat already has a user_id → WHERE matches nothing
    });
    const res = await app.request('/api/invitations/claim', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { claimed: unknown[] }).claimed).toEqual([]);
    // members update attempted, but the invitation was NOT flipped.
    expect(updatedTables).toContain(members);
    expect(updatedTables).not.toContain(pendingInvitations);
  });

  it('creates a member seat for a seatless invite (members-page invites, FHS-276)', async () => {
    const { app, updatedTables, insertedTables } = buildApp({
      invites: [{ id: INVITE_ID, tenantId: TENANT_ID, memberId: null, role: 'adult' }],
    });
    const res = await app.request('/api/invitations/claim', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { claimed: Array<{ slug: string }> };
    expect(body.claimed).toEqual([{ tenantId: TENANT_ID, slug: 'khans' }]);
    // A members row was created (display name from email local-part) and
    // the invitation was flipped to accepted.
    expect(insertedTables).toContain(members);
    expect(updatedTables).toContain(pendingInvitations);
  });
});
