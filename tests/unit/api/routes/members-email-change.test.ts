import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { membersRouter } from '../../../../apps/api/src/routes/members.js';
import { memberEmailChanges, users } from '../../../../apps/api/src/db/schema.js';
import type { User } from '../../../../apps/api/src/db/schema.js';

// FHS-510 — a member changes THEIR OWN sign-in email, confirmed by a
// one-time emailed link. Self-serve only: nobody can change someone
// else's login email, admin or not.
//
//   POST /api/members/:id/email-change          — self-serve, starts it.
//   POST /api/members/email-change/confirm       — PUBLIC, applies it.
//   POST /api/members/:id/email-change/cancel    — self-serve, drops it.

const pinRequestTenant = vi.fn(async () => undefined);
const dbMock = {
  select: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
};
vi.mock('../../../../apps/api/src/db/client.js', () => ({
  getDb: () => dbMock,
  pinRequestTenant: (...args: unknown[]) => pinRequestTenant(...args),
}));

// Mocks ONLY `sendEmail` — `escapeHtml` stays the real implementation so the
// HTML-escaping tests below exercise the actual escaping logic, not a stub.
const sendEmail = vi.fn();
vi.mock('../../../../apps/api/src/lib/email.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../apps/api/src/lib/email.js')>(
    '../../../../apps/api/src/lib/email.js',
  );
  return {
    ...actual,
    sendEmail: (...args: unknown[]) => sendEmail(...args),
  };
});

const updateUserEmailById = vi.fn();
vi.mock('../../../../apps/api/src/lib/supabase-admin.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../apps/api/src/lib/supabase-admin.js')
  >('../../../../apps/api/src/lib/supabase-admin.js');
  return {
    ...actual,
    updateUserEmailById: (...args: unknown[]) => updateUserEmailById(...args),
  };
});

vi.mock('../../../../apps/api/src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../apps/api/src/config.js')>(
    '../../../../apps/api/src/config.js',
  );
  return {
    ...actual,
    config: { ...actual.config, APP_BASE_URL: 'https://app.familyhub.test' },
  };
});

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
// The authenticated caller's Supabase user id (JWT `sub`) — seeded onto
// every request by seedAuth() below.
const CALLER_USER_ID = '00000000-0000-4000-8000-000000000777';
// TARGET_ID doubles as: (a) the "self" member row id in the START/CANCEL
// self-serve tests (the caller's own seat), and (b) the member row the
// PUBLIC confirm endpoint applies a change to (an unrelated fixture, since
// that describe block seeds no caller at all).
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
// Another member's linked Supabase user id — used only to prove the
// self-serve check rejects a caller targeting someone else's row.
const TARGET_USER_ID = '33333333-3333-4333-8333-333333333333';
const CHANGE_ID = '44444444-4444-4444-8444-444444444444';

const FIXED_CALLER: User = {
  id: CALLER_USER_ID,
  email: 'caller@example.com',
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
  updatedAt: new Date('2026-05-01T00:00:00.000Z'),
};

// Chain stub: from/where/limit are no-ops returning `this`; returning()/the
// promise-then hook resolve to `rows`. Matches the pattern used across the
// other members route test files.
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

/** Queue N rows-arrays for consecutive db.select(...) calls, in call order. */
function queueSelects(...sequence: unknown[][]) {
  let idx = 0;
  dbMock.select.mockImplementation(() => {
    const rows = sequence[idx] ?? [];
    idx += 1;
    return chain(rows);
  });
}

function seedAuth() {
  const seed: MiddlewareHandler = async (c, next) => {
    c.set('user', { id: CALLER_USER_ID, email: FIXED_CALLER.email, claims: {} });
    c.set('userRow', FIXED_CALLER);
    c.set('tenantId', TENANT_ID);
    await next();
  };
  const app = new Hono();
  app.use('*', seed);
  app.route('/api/members', membersRouter);
  return app;
}

function publicApp() {
  // The confirm endpoint is PUBLIC — no seed middleware sets user/userRow/
  // tenantId, matching production (it's exempted from authMiddleware via
  // PUBLIC_PATH_PREFIXES, which never runs in this unit test at all).
  const app = new Hono();
  app.route('/api/members', membersRouter);
  return app;
}

beforeEach(() => {
  dbMock.select.mockReset();
  dbMock.insert.mockReset();
  dbMock.delete.mockReset();
  dbMock.execute.mockReset();
  dbMock.transaction.mockReset();
  pinRequestTenant.mockClear();
  sendEmail.mockReset();
  updateUserEmailById.mockReset();

  dbMock.insert.mockImplementation(() => chain([{ id: CHANGE_ID }]));
  dbMock.delete.mockImplementation(() => chain([]));
  sendEmail.mockResolvedValue({ ok: true });
});

describe('FHS-510 — POST /api/members/:id/email-change (self-serve, starts the change)', () => {
  it('caller is not a member of this tenant → 403, nothing written, no email sent', async () => {
    queueSelects([]); // caller lookup empty
    const app = seedAuth();
    const res = await app.request(`/api/members/${TARGET_ID}/email-change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com' }),
    });
    expect(res.status).toBe(403);
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("caller targeting ANOTHER member's row → 403, nothing written, no email sent (self-serve enforcement)", async () => {
    queueSelects(
      [{ id: 'caller-member-id', role: 'adult' }],
      // target belongs to someone else — a different linked userId.
      [{ id: TARGET_ID, userId: TARGET_USER_ID, displayName: 'Yusuf' }],
    );
    const app = seedAuth();
    const res = await app.request(`/api/members/${TARGET_ID}/email-change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toMatch(/you can only change your own sign-in email/i);
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('target member id not found in this tenant → 404', async () => {
    queueSelects([{ id: 'caller-member-id', role: 'adult' }], []); // target lookup empty
    const app = seedAuth();
    const res = await app.request(`/api/members/${TARGET_ID}/email-change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com' }),
    });
    expect(res.status).toBe(404);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  // NOTE: a "target has no linked login (userId null) → NO_LOGIN_EMAIL"
  // branch exists in the handler for defence-in-depth, but it is
  // unreachable through self-serve: the caller's own userId (from their
  // JWT) is never null, so `target.userId !== userRow.id` always trips
  // first and returns 403 before that check runs. No test can legitimately
  // reach it under the self-serve contract.

  it('new email already registered to another account → 409, no insert/send', async () => {
    queueSelects(
      [{ id: TARGET_ID, role: 'adult' }],
      // self-serve happy path: target IS the caller's own row.
      [{ id: TARGET_ID, userId: CALLER_USER_ID, displayName: 'Yusuf' }],
      [{ email: 'yusuf@old.example.com' }], // current email lookup
      [{ id: 'some-other-user-id' }], // existing-email lookup: a collision
    );
    const app = seedAuth();
    const res = await app.request(`/api/members/${TARGET_ID}/email-change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'taken@example.com' }),
    });
    expect(res.status).toBe(409);
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('happy path — a member changes their OWN email: creates a hashed pending row, emails the NEW address, and heads-up notices the OLD address', async () => {
    queueSelects(
      [{ id: TARGET_ID, role: 'adult' }],
      [{ id: TARGET_ID, userId: CALLER_USER_ID, displayName: 'Yusuf' }],
      [{ email: 'yusuf@old.example.com' }],
      [], // no email collision
    );
    let insertedValues: Record<string, unknown> | null = null;
    dbMock.insert.mockImplementation(() => ({
      values: (v: Record<string, unknown>) => {
        insertedValues = v;
        return { returning: () => Promise.resolve([{ id: CHANGE_ID }]) };
      },
    }));

    const app = seedAuth();
    const res = await app.request(`/api/members/${TARGET_ID}/email-change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'Yusuf.New@Example.com' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pendingEmail: string };
    expect(body.pendingEmail).toBe('yusuf.new@example.com'); // lower-cased

    // The row written to the DB carries a 64-hex-char SHA-256 hash, never a
    // field holding the raw token.
    expect(insertedValues).toMatchObject({
      tenantId: TENANT_ID,
      memberId: TARGET_ID,
      newEmail: 'yusuf.new@example.com',
    });
    expect(insertedValues).toHaveProperty('tokenHash');
    expect((insertedValues as unknown as { tokenHash: string }).tokenHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(Object.keys(insertedValues as object)).not.toContain('token');

    // TWO emails go out: the confirm link to the NEW address, and a
    // heads-up (no action link) to the OLD address — FHS-510 blocker #2.
    expect(sendEmail).toHaveBeenCalledTimes(2);

    const primary = sendEmail.mock.calls[0]![0] as { to: string; html: string };
    expect(primary.to).toBe('yusuf.new@example.com');
    const match = /confirm-email\/([^"?]+)\?token=([^"&\s]+)/.exec(primary.html);
    expect(match?.[1]).toBe(TARGET_ID);
    const rawTokenInLink = match?.[2];
    expect(rawTokenInLink).toBeTruthy();
    expect(rawTokenInLink).not.toBe((insertedValues as unknown as { tokenHash: string }).tokenHash);

    const oldAddressNotice = sendEmail.mock.calls[1]![0] as { to: string; html: string };
    expect(oldAddressNotice.to).toBe('yusuf@old.example.com');
    expect(oldAddressNotice.html).toContain('yusuf.new@example.com');
    // No action link in the heads-up — it's informational only.
    expect(oldAddressNotice.html).not.toContain('confirm-email');
  });

  it('escapes a malicious display name in BOTH emails (HTML/link injection guard)', async () => {
    const evilName = '<img src=x onerror=alert(1)>Yusuf';
    queueSelects(
      [{ id: TARGET_ID, role: 'adult' }],
      [{ id: TARGET_ID, userId: CALLER_USER_ID, displayName: evilName }],
      [{ email: 'yusuf@old.example.com' }],
      [],
    );
    const app = seedAuth();
    const res = await app.request(`/api/members/${TARGET_ID}/email-change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com' }),
    });
    expect(res.status).toBe(200);
    for (const call of sendEmail.mock.calls) {
      const html = (call[0] as { html: string }).html;
      expect(html).not.toContain('<img src=x onerror=alert(1)>');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;Yusuf');
    }
  });

  it('a failed old-address heads-up notice is logged but does NOT block the 200', async () => {
    queueSelects(
      [{ id: TARGET_ID, role: 'adult' }],
      [{ id: TARGET_ID, userId: CALLER_USER_ID, displayName: 'Yusuf' }],
      [{ email: 'yusuf@old.example.com' }],
      [],
    );
    sendEmail
      .mockResolvedValueOnce({ ok: true }) // primary (new address) succeeds
      .mockResolvedValueOnce({ ok: false, error: 'boom' }); // old-address notice fails
    const app = seedAuth();
    const res = await app.request(`/api/members/${TARGET_ID}/email-change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com' }),
    });
    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    // delete() is called exactly once here — the "invalidate any prior
    // pending row" step every request makes. The pending row is NOT rolled
    // back on top of that; only the PRIMARY send failing triggers a
    // rollback (see the next test).
    expect(dbMock.delete).toHaveBeenCalledTimes(1);
  });

  it('email send failure rolls back the pending row and returns 502 (old-address notice never fires)', async () => {
    queueSelects(
      [{ id: TARGET_ID, role: 'adult' }],
      [{ id: TARGET_ID, userId: CALLER_USER_ID, displayName: 'Yusuf' }],
      [{ email: 'yusuf@old.example.com' }],
      [],
    );
    sendEmail.mockResolvedValue({ ok: false, error: 'boom' });
    let deletedTable: unknown = null;
    dbMock.delete.mockImplementation((table: unknown) => {
      deletedTable = table;
      return chain([]);
    });

    const app = seedAuth();
    const res = await app.request(`/api/members/${TARGET_ID}/email-change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com' }),
    });
    expect(res.status).toBe(502);
    expect(deletedTable).toBe(memberEmailChanges);
    // Called twice: the "invalidate any prior pending row" step, then the
    // rollback of the row this request just inserted.
    expect(dbMock.delete).toHaveBeenCalledTimes(2);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('a concurrent request for the same member (unique-violation on insert) → 409', async () => {
    queueSelects(
      [{ id: TARGET_ID, role: 'adult' }],
      [{ id: TARGET_ID, userId: CALLER_USER_ID, displayName: 'Yusuf' }],
      [{ email: 'yusuf@old.example.com' }],
      [],
    );
    const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });
    dbMock.insert.mockImplementation(() => ({
      values: () => ({ returning: () => Promise.reject(uniqueViolation) }),
    }));
    const app = seedAuth();
    const res = await app.request(`/api/members/${TARGET_ID}/email-change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com' }),
    });
    expect(res.status).toBe(409);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('FHS-510 — POST /api/members/:id/email-change/cancel (self-serve)', () => {
  it('caller is not a member of this tenant → 403, no delete', async () => {
    queueSelects([]);
    const app = seedAuth();
    const res = await app.request(`/api/members/${TARGET_ID}/email-change/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(403);
    expect(dbMock.delete).not.toHaveBeenCalled();
  });

  it("cancelling ANOTHER member's pending change → 403, no delete", async () => {
    // caller.id ('some-other-member-id') does not match the :id path param
    // (TARGET_ID) — you can only cancel your own change.
    queueSelects([{ id: 'some-other-member-id', role: 'adult' }]);
    const app = seedAuth();
    const res = await app.request(`/api/members/${TARGET_ID}/email-change/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toMatch(/you can only cancel your own email change/i);
    expect(dbMock.delete).not.toHaveBeenCalled();
  });

  it('self-cancel → 200 { cancelled: true }, deletes the pending row', async () => {
    // caller.id matches the :id path param — cancelling your OWN change.
    queueSelects([{ id: TARGET_ID, role: 'adult' }]);
    let deletedTable: unknown = null;
    dbMock.delete.mockImplementation((table: unknown) => {
      deletedTable = table;
      return chain([]);
    });
    const app = seedAuth();
    const res = await app.request(`/api/members/${TARGET_ID}/email-change/cancel`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { cancelled: boolean }).toEqual({ cancelled: true });
    expect(deletedTable).toBe(memberEmailChanges);
  });
});

describe('FHS-510 — POST /api/members/email-change/confirm (PUBLIC)', () => {
  function txMock(opts: { throws?: Error } = {}) {
    const tx = { execute: vi.fn(async () => ({ rows: [] })), update: vi.fn(() => chain([])) };
    dbMock.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      if (opts.throws) throw opts.throws;
      return fn(tx);
    });
    return tx;
  }

  function mockPendingRow(over: Partial<Record<string, unknown>> = {}) {
    dbMock.execute.mockResolvedValue({
      rows: [
        {
          id: CHANGE_ID,
          tenant_id: TENANT_ID,
          member_id: TARGET_ID,
          new_email: 'yusuf.new@example.com',
          expires_at: new Date(Date.now() + 60_000),
          used_at: null,
          ...over,
        },
      ],
    });
  }

  it('no matching row (wrong token) → 410 expired, no Supabase call', async () => {
    dbMock.execute.mockResolvedValue({ rows: [] });
    const app = publicApp();
    const res = await app.request('/api/members/email-change/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: TARGET_ID, token: 'wrong-token' }),
    });
    expect(res.status).toBe(410);
    expect(updateUserEmailById).not.toHaveBeenCalled();
  });

  it('already-used row → 410 expired', async () => {
    mockPendingRow({ used_at: new Date('2026-05-01T00:00:00.000Z') });
    const app = publicApp();
    const res = await app.request('/api/members/email-change/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: TARGET_ID, token: 'some-token' }),
    });
    expect(res.status).toBe(410);
    expect(updateUserEmailById).not.toHaveBeenCalled();
  });

  it('expired row (past expires_at) → 410 expired', async () => {
    mockPendingRow({ expires_at: new Date(Date.now() - 1000) });
    const app = publicApp();
    const res = await app.request('/api/members/email-change/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: TARGET_ID, token: 'some-token' }),
    });
    expect(res.status).toBe(410);
    expect(updateUserEmailById).not.toHaveBeenCalled();
  });

  it('happy path — pins the tenant, updates Supabase + the mirror, marks used, notifies the OLD address, returns the new email', async () => {
    mockPendingRow();
    // select #1: target member lookup. select #2: the OLD (soon-to-be-
    // replaced) email, captured BEFORE anything mutates it. select #3
    // (after the transaction): tenants.slug lookup.
    queueSelects(
      [{ id: TARGET_ID, userId: TARGET_USER_ID, displayName: 'Yusuf' }],
      [{ email: 'yusuf.old@example.com' }],
      [{ slug: 'khans' }],
    );
    updateUserEmailById.mockResolvedValue(undefined);
    const tx = txMock();

    const app = publicApp();
    const res = await app.request('/api/members/email-change/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: TARGET_ID, token: 'the-raw-token' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { newEmail: string; memberName: string; tenantSlug: string };
    expect(body).toEqual({
      newEmail: 'yusuf.new@example.com',
      memberName: 'Yusuf',
      tenantSlug: 'khans',
    });

    expect(pinRequestTenant).toHaveBeenCalledWith(TENANT_ID);
    expect(updateUserEmailById).toHaveBeenCalledWith(TARGET_USER_ID, 'yusuf.new@example.com');
    expect(tx.update).toHaveBeenCalledWith(users);
    expect(tx.update).toHaveBeenCalledWith(memberEmailChanges);

    // The lookup itself hashes the SAME way the request handler does, so a
    // regression that swaps SHA-256 for something else would be caught by
    // this handshake test rather than only surfacing at runtime.
    const expectedHash = createHash('sha256').update('the-raw-token').digest('hex');
    const executedSql = dbMock.execute.mock.calls[0]![0] as { queryChunks?: unknown };
    expect(JSON.stringify(executedSql)).toContain(expectedHash);

    // FHS-510 blocker #2 — the OLD address gets a completion notice.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const notice = sendEmail.mock.calls[0]![0] as { to: string; html: string };
    expect(notice.to).toBe('yusuf.old@example.com');
    expect(notice.html).toContain('yusuf.new@example.com');
  });

  it('a failed old-address completion notice is logged but does NOT change the 200 response', async () => {
    mockPendingRow();
    queueSelects(
      [{ id: TARGET_ID, userId: TARGET_USER_ID, displayName: 'Yusuf' }],
      [{ email: 'yusuf.old@example.com' }],
      [{ slug: 'khans' }],
    );
    updateUserEmailById.mockResolvedValue(undefined);
    txMock();
    sendEmail.mockResolvedValue({ ok: false, error: 'boom' });

    const app = publicApp();
    const res = await app.request('/api/members/email-change/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: TARGET_ID, token: 'the-raw-token' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { newEmail: string };
    expect(body.newEmail).toBe('yusuf.new@example.com');
  });

  it('member removed / unlinked since the request → 410 expired (no Supabase call)', async () => {
    mockPendingRow();
    queueSelects([]); // target lookup: member gone
    const app = publicApp();
    const res = await app.request('/api/members/email-change/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: TARGET_ID, token: 'some-token' }),
    });
    expect(res.status).toBe(410);
    expect(updateUserEmailById).not.toHaveBeenCalled();
  });

  it('Supabase admin update failure → 502 EMAIL_CHANGE_APPLY_FAILED (retryable, NOT expired), users mirror untouched', async () => {
    mockPendingRow();
    queueSelects(
      [{ id: TARGET_ID, userId: TARGET_USER_ID, displayName: 'Yusuf' }],
      [{ email: 'yusuf.old@example.com' }],
    );
    updateUserEmailById.mockRejectedValue(new Error('supabase down'));
    const app = publicApp();
    const res = await app.request('/api/members/email-change/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: TARGET_ID, token: 'some-token' }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { errorCode: string };
    expect(body.errorCode).toBe('EMAIL_CHANGE_APPLY_FAILED');
    expect(dbMock.transaction).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  // FHS-510 blocker #3 — Supabase succeeds but the local apply (users
  // mirror + used_at) throws: this is a DRIFT, must be reported distinctly
  // and NEVER re-shown to the user as "the link expired" (that would
  // suggest nothing happened, when in fact Supabase already changed).
  it('local-apply failure AFTER a successful Supabase update → 500 EMAIL_CHANGE_APPLY_FAILED (drift, not expired)', async () => {
    mockPendingRow();
    queueSelects(
      [{ id: TARGET_ID, userId: TARGET_USER_ID, displayName: 'Yusuf' }],
      [{ email: 'yusuf.old@example.com' }],
    );
    updateUserEmailById.mockResolvedValue(undefined);
    txMock({ throws: new Error('connection reset') });

    const app = publicApp();
    const res = await app.request('/api/members/email-change/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: TARGET_ID, token: 'some-token' }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { errorCode: string };
    expect(body.errorCode).toBe('EMAIL_CHANGE_APPLY_FAILED');
    // No completion notice — the local apply never committed.
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
