import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { membersRouter } from '../../../../apps/api/src/routes/members.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-108: GET /api/members. Stub the DB at the module boundary;
// seed user + tenant context via a tiny middleware. Same shape as the
// onboarding/invitations route tests.

const dbMock = { select: vi.fn() };
vi.mock('../../../../apps/api/src/db/client.js', () => ({
  getDb: () => dbMock,
}));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const CALLER_MEMBER_ID = '99999999-9999-4999-8999-999999999999';
const USER_EMAIL = 'sarah@example.com';
const FIXED_USER: User = {
  id: USER_ID,
  email: USER_EMAIL,
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
  updatedAt: new Date('2026-05-01T00:00:00.000Z'),
};

interface SeedOpts {
  noTenant?: boolean;
  callerMissing?: boolean;
  /** Caller's role in the tenant: echoed back as `callerRole`. */
  callerRole?: string;
  /** Row for the caller's OWN current sign-in email (users select). */
  ownEmailRow?: { email: string } | null;
  /** Row for the caller's OWN in-flight pending email change, if any. */
  ownPendingRow?: { memberId: string; newEmail: string } | null;
}

function buildAppWithSeed(opts: SeedOpts = {}, members: unknown[] = []) {
  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: USER_ID, email: USER_EMAIL, claims: {} });
    c.set('userRow', FIXED_USER);
    c.set('tenantId', opts.noTenant ? undefined : TENANT_ID);
    await next();
  };

  // FHS-510: self-serve: every request that reaches the members list runs
  // FIVE selects, in order: caller-membership lookup, members list, pending
  // invites (FHS-276), then the caller's OWN current sign-in email, then the
  // caller's OWN in-flight pending email change. There is no admin-only
  // branch any more: both of the last two selects always fire, and they
  // only ever resolve the CALLER's own data (see routes/members.ts).
  let selectCallIdx = 0;
  dbMock.select.mockImplementation(() => {
    selectCallIdx += 1;
    if (selectCallIdx === 1) {
      return {
        from: () => ({
          where: () => ({
            // FHS-252: role is selected too so the handler can return
            // it as `callerRole` for the members page to gate admin-
            // only PIN affordances.
            limit: () =>
              Promise.resolve(
                opts.callerMissing
                  ? []
                  : [{ id: CALLER_MEMBER_ID, role: opts.callerRole ?? 'admin' }],
              ),
          }),
        }),
      };
    }
    if (selectCallIdx === 2) {
      return {
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve(members),
          }),
        }),
      };
    }
    if (selectCallIdx === 3) {
      // FHS-276 pending invites (none in these fixtures).
      return {
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      };
    }
    if (selectCallIdx === 4) {
      // FHS-510: the caller's own current sign-in email.
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(opts.ownEmailRow ? [opts.ownEmailRow] : []),
          }),
        }),
      };
    }
    // FHS-510: the caller's own in-flight pending email change.
    return {
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(opts.ownPendingRow ? [opts.ownPendingRow] : []),
        }),
      }),
    };
  });

  const app = new Hono();
  app.use('*', seed);
  app.route('/api/members', membersRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
});

describe('FHS-108: GET /api/members', () => {
  it('returns 400 when no tenant is on the request', async () => {
    const app = buildAppWithSeed({ noTenant: true });
    const res = await app.request('/api/members');
    expect(res.status).toBe(400);
  });

  it('returns 403 when the caller is not a member of the tenant', async () => {
    const app = buildAppWithSeed({ callerMissing: true });
    const res = await app.request('/api/members');
    expect(res.status).toBe(403);
  });

  it('returns 200 with an empty list when the tenant has no members', async () => {
    const app = buildAppWithSeed({}, []);
    const res = await app.request('/api/members');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: unknown[] };
    expect(body.members).toEqual([]);
  });

  it('derives status=active when user_id is set, status=unclaimed otherwise', async () => {
    const baseDate = new Date('2026-05-02T00:00:00.000Z');
    const M1 = '22222222-2222-4222-8222-222222222222';
    const M2 = '33333333-3333-4333-8333-333333333333';
    const app = buildAppWithSeed({}, [
      {
        id: M1,
        displayName: 'Sarah',
        role: 'admin',
        avatarEmoji: '👩',
        userId: USER_ID,
        createdAt: baseDate,
        // FHS-252: handler now reads is_child + pin_hash to derive
        // the per-row hasPin boolean. Stub them to safe defaults.
        isChild: false,
        pinHash: null,
      },
      {
        id: M2,
        displayName: 'Iman',
        role: 'child',
        avatarEmoji: '👧',
        userId: null,
        createdAt: baseDate,
        isChild: false,
        pinHash: null,
      },
    ]);
    const res = await app.request('/api/members');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: Array<{ id: string; status: string; role: string; avatarEmoji: string | null }>;
      callerRole: string;
      callerMemberId: string;
    };
    expect(body.members).toHaveLength(2);
    // FHS-523: the caller's own member id + role are echoed back so a page can
    // show the caller's roster name (child-world pill) without a second fetch.
    expect(body.callerRole).toBe('admin');
    expect(body.callerMemberId).toBe(CALLER_MEMBER_ID);
    expect(body.members[0]).toMatchObject({
      id: M1,
      role: 'admin',
      status: 'active',
      avatarEmoji: '👩',
    });
    expect(body.members[1]).toMatchObject({
      id: M2,
      role: 'child',
      status: 'unclaimed',
      avatarEmoji: '👧',
    });
  });

  // FHS-510: email / pendingEmail are self-serve: a member sees ONLY their
  // OWN sign-in email + their OWN in-flight change. There is no "admin sees
  // everyone's login email" mode any more (FHS-510 pivot).
  describe('email / pendingEmail gating (FHS-510, self-serve)', () => {
    const baseDate = new Date('2026-05-02T00:00:00.000Z');
    // This row's id matches CALLER_MEMBER_ID: it IS the caller's own seat.
    const OWN_ROW_ID = CALLER_MEMBER_ID;
    const OTHER_MEMBER_ID = '55555555-5555-4555-8555-555555555555';

    function ownRow(over: Partial<Record<string, unknown>> = {}) {
      return {
        id: OWN_ROW_ID,
        displayName: 'Sarah',
        role: 'admin',
        avatarEmoji: '👩',
        userId: USER_ID,
        createdAt: baseDate,
        isChild: false,
        pinHash: null,
        ...over,
      };
    }

    function otherMemberRow(over: Partial<Record<string, unknown>> = {}) {
      return {
        id: OTHER_MEMBER_ID,
        displayName: 'Yusuf',
        role: 'adult',
        avatarEmoji: '👨',
        userId: '77777777-7777-4777-8777-777777777777',
        createdAt: baseDate,
        isChild: false,
        pinHash: null,
        ...over,
      };
    }

    it("the caller's own row carries their real email + pendingEmail; every other row is always null", async () => {
      const app = buildAppWithSeed(
        {
          ownEmailRow: { email: 'sarah@example.com' },
          ownPendingRow: { memberId: OWN_ROW_ID, newEmail: 'sarah.new@example.com' },
        },
        [ownRow(), otherMemberRow()],
      );
      const res = await app.request('/api/members');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        members: Array<{ id: string; email: string | null; pendingEmail: string | null }>;
      };
      expect(body.members[0]).toMatchObject({
        id: OWN_ROW_ID,
        email: 'sarah@example.com',
        pendingEmail: 'sarah.new@example.com',
      });
      // Another member's row NEVER carries email/pendingEmail: a grown-up's
      // private login is not roster data every family member can see.
      expect(body.members[1]).toMatchObject({
        id: OTHER_MEMBER_ID,
        email: null,
        pendingEmail: null,
      });
      // 5 selects, always: caller, members, invites, own email, own pending.
      expect(dbMock.select).toHaveBeenCalledTimes(5);
    });

    it("the caller's own row shows email but null pendingEmail when there is no change in flight", async () => {
      const app = buildAppWithSeed(
        {
          ownEmailRow: { email: 'sarah@example.com' },
          ownPendingRow: null,
        },
        [ownRow()],
      );
      const res = await app.request('/api/members');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        members: Array<{ email: string | null; pendingEmail: string | null }>;
      };
      expect(body.members[0]).toMatchObject({
        email: 'sarah@example.com',
        pendingEmail: null,
      });
    });
  });
});
