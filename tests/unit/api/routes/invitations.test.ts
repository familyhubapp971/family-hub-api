import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invitationsRouter } from '../../../../apps/api/src/routes/invitations.js';
import type { User, PendingInvitation } from '../../../../apps/api/src/db/schema.js';

// FHS-91 — POST /api/invitations.
//
// Tests the route handler in isolation. The DB client and the Supabase
// admin client are both stubbed at the module boundary; the resolved
// tenant + authenticated user are seeded by a tiny stub middleware
// rather than going through the real auth + resolveTenant chain.

// ─── Stubs ────────────────────────────────────────────────────────────

const dbMock = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
};
vi.mock('../../../../apps/api/src/db/client.js', () => ({
  getDb: () => dbMock,
}));

const inviteUserByEmail = vi.fn();
vi.mock('../../../../apps/api/src/lib/supabase-admin.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../apps/api/src/lib/supabase-admin.js')
  >('../../../../apps/api/src/lib/supabase-admin.js');
  return {
    ...actual,
    inviteUserByEmail: (...args: unknown[]) => inviteUserByEmail(...args),
  };
});

// Pin APP_BASE_URL so the route doesn't 500 with "server misconfigured".
vi.mock('../../../../apps/api/src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../apps/api/src/config.js')>(
    '../../../../apps/api/src/config.js',
  );
  return {
    ...actual,
    config: {
      ...actual.config,
      APP_BASE_URL: 'https://staging.familyhub.test',
      SUPABASE_URL: 'https://abc.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'svc-test-key',
    },
  };
});

// ─── Fixtures ─────────────────────────────────────────────────────────

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const USER_EMAIL = 'sarah@example.com';
const CALLER_MEMBER_ID = '22222222-2222-4222-8222-222222222222';

const FIXED_USER: User = {
  id: USER_ID,
  email: USER_EMAIL,
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
  updatedAt: new Date('2026-05-01T00:00:00.000Z'),
};

function fixedInvitation(over: Partial<PendingInvitation> = {}): PendingInvitation {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    tenantId: TENANT_ID,
    email: 'invitee@example.com',
    role: 'adult',
    invitedBy: CALLER_MEMBER_ID,
    supabaseInviteId: null,
    status: 'pending',
    createdAt: new Date('2026-05-03T00:00:00.000Z'),
    updatedAt: new Date('2026-05-03T00:00:00.000Z'),
    ...over,
  };
}

interface SeedOpts {
  noUser?: boolean;
  noTenant?: boolean;
  callerRole?: 'admin' | 'adult' | 'teen' | 'child' | 'guest';
  callerMissing?: boolean;
}

function buildAppWithSeed(opts: SeedOpts = {}) {
  // Tiny stub of (auth + resolveTenant) — sets the context vars the
  // route reads. Avoids minting real JWTs / wiring the DB lookup
  // for tenant resolution since neither is what we're testing here.
  const seed: MiddlewareHandler = async (c, next) => {
    if (!opts.noUser) {
      c.set('user', { id: USER_ID, email: USER_EMAIL, claims: {} });
      c.set('userRow', FIXED_USER);
    }
    c.set('tenantId', opts.noTenant ? undefined : TENANT_ID);
    await next();
  };
  // Caller-membership lookup. The route does:
  //   db.select(...).from(members).where(...).limit(1)
  if (opts.callerMissing) {
    dbMock.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    });
  } else {
    dbMock.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([{ id: CALLER_MEMBER_ID, role: opts.callerRole ?? 'admin' }]),
        }),
      }),
    });
  }

  const app = new Hono();
  app.use('*', seed);
  app.route('/api/invitations', invitationsRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
  dbMock.update.mockReset();
  inviteUserByEmail.mockReset();
});

// ─── Tests ────────────────────────────────────────────────────────────

describe('FHS-91 — POST /api/invitations', () => {
  it('returns 400 when no tenant is on the request', async () => {
    const app = buildAppWithSeed({ noTenant: true });
    const res = await app.request('/api/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'invitee@example.com' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('tenant context required');
  });

  it('returns 403 when the caller is not a member of the tenant', async () => {
    const app = buildAppWithSeed({ callerMissing: true });
    const res = await app.request('/api/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'invitee@example.com' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 when the caller is a child / teen / guest', async () => {
    const app = buildAppWithSeed({ callerRole: 'child' });
    const res = await app.request('/api/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'invitee@example.com' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toMatch(/admin or adult/);
  });

  it('returns 400 when the body is missing email', async () => {
    const app = buildAppWithSeed();
    const res = await app.request('/api/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when role is not in the allowlist (e.g. admin)', async () => {
    const app = buildAppWithSeed();
    const res = await app.request('/api/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'invitee@example.com', role: 'admin' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 409 when the same email already has a pending invite (unique-violation)', async () => {
    const app = buildAppWithSeed();
    const dupErr = Object.assign(new Error('duplicate'), { code: '23505' });
    dbMock.insert.mockReturnValue({
      values: () => ({ returning: () => Promise.reject(dupErr) }),
    });
    const res = await app.request('/api/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'invitee@example.com' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.error).toBe('invitation already pending');
    expect(body.field).toBe('email');
    expect(inviteUserByEmail).not.toHaveBeenCalled();
  });

  it('returns 201 with the invitation on the happy path', async () => {
    const app = buildAppWithSeed();
    const inv = fixedInvitation();
    // Capture the values() arg so we can assert the row written to
    // the DB has the normalised (lower-cased) email — otherwise a
    // regression that lower-cases only on the response would silently
    // break the partial unique index.
    let insertedValues: unknown = null;
    dbMock.insert.mockReturnValue({
      values: (val: unknown) => {
        insertedValues = val;
        return { returning: () => Promise.resolve([inv]) };
      },
    });
    dbMock.update.mockReturnValue({
      set: () => ({ where: () => Promise.resolve() }),
    });
    inviteUserByEmail.mockResolvedValue({ id: 'supabase-user-uuid' });

    const res = await app.request('/api/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'Invitee@Example.com', role: 'teen' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      invitation: { email: string; role: string; status: string };
    };
    expect(body.invitation.email).toBe('invitee@example.com'); // normalised lower-case
    expect(body.invitation.status).toBe('pending');

    // The DB insert MUST receive the normalised email — the partial
    // unique index uses lower(email) so a mixed-case insert would
    // collide on the second attempt only by happy accident.
    expect(insertedValues).toMatchObject({
      tenantId: TENANT_ID,
      email: 'invitee@example.com',
      role: 'teen',
    });

    // redirect_to includes the invite id so the accept handler (FHS-92)
    // can read it after the Supabase round-trip.
    expect(inviteUserByEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'invitee@example.com',
        redirectTo: expect.stringContaining(`/auth/callback?invite=${inv.id}`),
        data: expect.objectContaining({
          invite_id: inv.id,
          tenant_id: TENANT_ID,
          role: 'teen',
        }),
      }),
    );
  });

  it('marks the invite expired and returns 502 when Supabase admin call fails', async () => {
    const app = buildAppWithSeed();
    const inv = fixedInvitation();
    dbMock.insert.mockReturnValue({
      values: () => ({ returning: () => Promise.resolve([inv]) }),
    });
    let updateBody: unknown = null;
    dbMock.update.mockReturnValue({
      set: (val: unknown) => {
        updateBody = val;
        return { where: () => Promise.resolve() };
      },
    });
    inviteUserByEmail.mockRejectedValue(new Error('boom'));

    const res = await app.request('/api/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'invitee@example.com' }),
    });
    expect(res.status).toBe(502);
    expect(updateBody).toMatchObject({ status: 'expired' });
  });
});
