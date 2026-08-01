import { randomBytes, createHash } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { getDb, pinRequestTenant } from '../db/client.js';
import { members, pendingInvitations, memberEmailChanges, tenants, users } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { config } from '../config.js';
import { escapeHtml, sendEmail } from '../lib/email.js';
import { updateUserEmailById } from '../lib/supabase-admin.js';
import { createLogger } from '../logger.js';
import { KID_PIN_BCRYPT_COST, resetKidPinBucketForMember } from './auth-kid-pin.js';

const log = createLogger('members');

// FHS-108 — GET /api/members.
//
// Returns every member of the resolved tenant. Auth-gated; the caller
// must be a member of the tenant (any role). Used by the /t/:slug/members
// page to render the family list with role + status badges.
//
// Status is derived per row, not stored:
//   - active    — user_id IS NOT NULL (a real Supabase user is linked)
//   - unclaimed — user_id IS NULL (admin added the seat; nobody has
//     accepted yet — could be a wizard-added member or a pending invite
//     pre-acceptance)

const memberStatusValues = ['active', 'unclaimed'] as const;
type MemberStatus = (typeof memberStatusValues)[number];

export const memberItemSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  role: z.string(),
  avatarEmoji: z.string().nullable(),
  status: z.enum(memberStatusValues),
  createdAt: z.string().datetime(),
  // FHS-252 — `isChild + hasPin` lets the members page render
  // "Set kid PIN" vs "Reset PIN" without leaking the hash itself.
  isChild: z.boolean(),
  hasPin: z.boolean(),
  // FHS-276 — kid card badge ("Child (6)"); null when not collected.
  age: z.number().int().nullable(),
  // FHS-276 — latest pending invite for an unclaimed seat, so the page
  // can show the email + a Resend button.
  inviteEmail: z.string().nullable(),
  inviteId: z.string().uuid().nullable(),
  // FHS-510 — the grown-up's current sign-in email (null for kids and
  // unclaimed seats). Lets Manage Members gate + label "Change email".
  email: z.string().nullable(),
  // FHS-510 — a new email awaiting confirmation for the caller's OWN row, if
  // they have a change in flight. Null otherwise (and always null on other
  // members' rows — a login email is not roster data).
  pendingEmail: z.string().nullable(),
});

export const listMembersResponseSchema = z.object({
  members: z.array(memberItemSchema),
  // FHS-252 — caller's role in this tenant. Lets the members page
  // gate admin-only affordances (set/reset kid PIN) without a second
  // round-trip. Cheap to compute server-side; the auth check
  // already loaded the row.
  callerRole: z.string(),
  // FHS-523 — the caller's own member id, so a page can find the caller's
  // roster display name (e.g. the child-world account pill) without leaking
  // their login email when the JWT carries no full_name.
  callerMemberId: z.string().uuid(),
});

export type ListMembersResponse = z.infer<typeof listMembersResponseSchema>;

export const membersRouter = new Hono().get('/', async (c) => {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) {
    throw new Error('members handler reached without userRow on context');
  }
  const tenantId = c.get('tenantId');
  if (!tenantId) {
    return c.json(
      {
        error: 'tenant context required',
        errorCode: 'TENANT_REQUIRED',
        detail: 'no tenantId resolved on this request',
      },
      400,
    );
  }

  const db = getDb();

  // Authorization: caller must be a member of the tenant. Any role
  // can list members (this is a read-only view of the family).
  const callerRows = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.userId, userRow.id)))
    .limit(1);
  if (callerRows.length === 0) {
    return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
  }
  const callerRole = callerRows[0]!.role;
  const callerMemberId = callerRows[0]!.id;

  // Members list — ordered by creation so the founding admin sits at
  // the top and the most recently added rows trail the list.
  const rows = await db
    .select({
      id: members.id,
      displayName: members.displayName,
      role: members.role,
      avatarEmoji: members.avatarEmoji,
      userId: members.userId,
      createdAt: members.createdAt,
      isChild: members.isChild,
      pinHash: members.pinHash,
      age: members.age,
    })
    .from(members)
    .where(eq(members.tenantId, tenantId))
    .orderBy(asc(members.createdAt));

  // FHS-276 — pending invites keyed by member seat (for unclaimed rows).
  const inviteRows = await db
    .select({
      id: pendingInvitations.id,
      memberId: pendingInvitations.memberId,
      email: pendingInvitations.email,
    })
    .from(pendingInvitations)
    .where(
      and(eq(pendingInvitations.tenantId, tenantId), eq(pendingInvitations.status, 'pending')),
    );
  const inviteByMember = new Map(
    inviteRows.filter((r) => r.memberId).map((r) => [r.memberId as string, r]),
  );

  // FHS-510 — self-serve: a member sees ONLY their OWN sign-in email + any
  // in-flight change of their own. Other members' private login emails are
  // never exposed on the roster. Both maps only ever hold the caller's own row.
  const emailByUserId = new Map<string, string>();
  const pendingEmailByMember = new Map<string, string>();
  {
    // The caller's own current sign-in email.
    const ownEmailRows = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userRow.id))
      .limit(1);
    if (ownEmailRows[0]) emailByUserId.set(userRow.id, ownEmailRows[0].email);

    // The caller's own pending (unused, unexpired) email change, if any. At
    // most one active row per member (partial unique index), so limit 1.
    const ownPendingRows = await db
      .select({ memberId: memberEmailChanges.memberId, newEmail: memberEmailChanges.newEmail })
      .from(memberEmailChanges)
      .where(
        and(
          eq(memberEmailChanges.tenantId, tenantId),
          eq(memberEmailChanges.memberId, callerMemberId),
          isNull(memberEmailChanges.usedAt),
          sql`${memberEmailChanges.expiresAt} > now()`,
        ),
      )
      .limit(1);
    for (const r of ownPendingRows) pendingEmailByMember.set(r.memberId, r.newEmail);
  }

  const response: ListMembersResponse = {
    members: rows.map((r) => {
      const status: MemberStatus = r.userId ? 'active' : 'unclaimed';
      const invite = r.userId ? undefined : inviteByMember.get(r.id);
      return {
        id: r.id,
        displayName: r.displayName,
        role: r.role,
        avatarEmoji: r.avatarEmoji,
        status,
        createdAt: r.createdAt.toISOString(),
        isChild: r.isChild,
        hasPin: r.pinHash !== null,
        age: r.age ?? null,
        inviteEmail: invite?.email ?? null,
        inviteId: invite?.id ?? null,
        // self only — the caller's own row carries email + pendingEmail; others null.
        email: r.id === callerMemberId ? (emailByUserId.get(userRow.id) ?? null) : null,
        pendingEmail: r.id === callerMemberId ? (pendingEmailByMember.get(r.id) ?? null) : null,
      };
    }),
    callerRole,
    callerMemberId,
  };
  return c.json(listMembersResponseSchema.parse(response));
});

// FHS-252 — PUT /api/members/:id/pin and DELETE /api/members/:id/pin.
//
// Lets an admin/adult set or clear a kid's 4-digit PIN, plus the
// is_child flag that gates kid-login eligibility. Without this the
// schema columns added in FHS-235 + the verify endpoint in FHS-236
// + the kid-login UI in FHS-238 are all unreachable from the product
// (kids can't log in unless somebody runs SQL by hand).
//
// Auth: caller must be admin or adult. Kids cannot change their own
// PIN — parents reset it for them. Same tenant scope as GET.
//
// On every write we also clear the per-memberId lockout bucket so
// resetting a locked-out kid's PIN immediately unblocks them.

const pinWriteParamsSchema = z.object({
  id: z.string().uuid('member id must be a UUID'),
});

const pinWriteBodySchema = z.object({
  pin: z.string().regex(/^\d{4}$/, 'pin must be exactly 4 digits'),
});

export const setMemberPinResponseSchema = z.object({
  member: z.object({
    id: z.string().uuid(),
    displayName: z.string(),
    isChild: z.boolean(),
    hasPin: z.boolean(),
  }),
});

export type SetMemberPinResponse = z.infer<typeof setMemberPinResponseSchema>;

const ADMIN_OR_ADULT_ROLES = new Set(['admin', 'adult']);
// FHS-252 — only child/teen members can have a kid-login PIN.
// Defence-in-depth: the page UI gates the affordance already, but a
// direct curl could otherwise PIN-flag an admin and surface them on
// the kid-login avatar grid.
const PIN_ELIGIBLE_TARGET_ROLES = new Set(['child', 'teen']);

membersRouter.put('/:id/pin', async (c) => {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) throw new Error('pin handler reached without userRow');
  const tenantId = c.get('tenantId');
  if (!tenantId) {
    return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
  }
  const params = pinWriteParamsSchema.safeParse({ id: c.req.param('id') });
  if (!params.success) {
    return c.json(
      {
        error: 'invalid request',
        issues: params.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    );
  }
  const body = (await c.req.json().catch(() => null)) as unknown;
  const parsed = pinWriteBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid request',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    );
  }

  const db = getDb();

  // Caller must be admin or adult in this tenant.
  const [callerRow] = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.userId, userRow.id)))
    .limit(1);
  if (!callerRow || !ADMIN_OR_ADULT_ROLES.has(callerRow.role)) {
    return c.json({ error: 'forbidden', detail: 'admins and adults can manage kid PINs' }, 403);
  }

  // Target member must exist in the same tenant.
  const [targetRow] = await db
    .select({ id: members.id, displayName: members.displayName, role: members.role })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.id, params.data.id)))
    .limit(1);
  if (!targetRow) {
    return c.json({ error: 'not found', detail: 'no such member in this tenant' }, 404);
  }
  if (!PIN_ELIGIBLE_TARGET_ROLES.has(targetRow.role)) {
    return c.json(
      {
        error: 'forbidden',
        detail: 'kid PIN can only be set on members with role child or teen',
        errorCode: 'PIN_TARGET_INELIGIBLE',
      },
      403,
    );
  }

  // Hash + write. Setting a PIN flips the is_child flag on so the
  // member appears on the kid-login avatar grid; the role enum is
  // left as-is (admins may reasonably keep `child`/`teen` as the
  // human-readable role).
  const pinHash = await bcrypt.hash(parsed.data.pin, KID_PIN_BCRYPT_COST);
  const [updated] = await db
    .update(members)
    .set({ pinHash, isChild: true })
    .where(and(eq(members.tenantId, tenantId), eq(members.id, params.data.id)))
    .returning({
      id: members.id,
      displayName: members.displayName,
      isChild: members.isChild,
      pinHash: members.pinHash,
    });

  // Clear any lockout bucket from prior wrong attempts.
  resetKidPinBucketForMember(params.data.id);

  const response: SetMemberPinResponse = {
    member: {
      id: updated!.id,
      displayName: updated!.displayName,
      isChild: updated!.isChild,
      hasPin: updated!.pinHash !== null,
    },
  };
  return c.json(setMemberPinResponseSchema.parse(response));
});

membersRouter.delete('/:id/pin', async (c) => {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) throw new Error('pin delete handler reached without userRow');
  const tenantId = c.get('tenantId');
  if (!tenantId) {
    return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
  }
  const params = pinWriteParamsSchema.safeParse({ id: c.req.param('id') });
  if (!params.success) {
    return c.json(
      {
        error: 'invalid request',
        issues: params.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    );
  }

  const db = getDb();

  const [callerRow] = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.userId, userRow.id)))
    .limit(1);
  if (!callerRow || !ADMIN_OR_ADULT_ROLES.has(callerRow.role)) {
    return c.json({ error: 'forbidden', detail: 'admins and adults can manage kid PINs' }, 403);
  }

  const [targetRow] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.id, params.data.id)))
    .limit(1);
  if (!targetRow) {
    return c.json({ error: 'not found', detail: 'no such member in this tenant' }, 404);
  }

  const [updated] = await db
    .update(members)
    .set({ pinHash: null, isChild: false })
    .where(and(eq(members.tenantId, tenantId), eq(members.id, params.data.id)))
    .returning({
      id: members.id,
      displayName: members.displayName,
      isChild: members.isChild,
      pinHash: members.pinHash,
    });

  resetKidPinBucketForMember(params.data.id);

  const response: SetMemberPinResponse = {
    member: {
      id: updated!.id,
      displayName: updated!.displayName,
      isChild: updated!.isChild,
      hasPin: updated!.pinHash !== null,
    },
  };
  return c.json(setMemberPinResponseSchema.parse(response));
});

// ─────────────────────────────────────────────────────────────────────────────
// FHS-276 / FHS-473 — Manage Members mutations.
//
// POST   /api/members        — add a child/teen/adult seat (name + optional
//                               age). Same direct-insert, no-login creation
//                               onboarding uses for a plain adult row (no
//                               email) — this endpoint is that path reused
//                               for the Manage Members "Add member" flow.
// PATCH  /api/members/:id    — rename, and/or toggle admin on parent rows.
// DELETE /api/members/:id    — remove a member (their content cascades).
//
// All three are admin-only (managing the family roster is an admin job;
// adults can still invite via onboarding/invitations). The last admin
// can never be demoted or removed — a family must always have one.
// ─────────────────────────────────────────────────────────────────────────────

const memberIdParamsSchema = z.object({ id: z.string().uuid('member id must be a UUID') });

// FHS-473 — 'adult' added alongside 'child'/'teen' so Manage Members can add
// any non-login family member type, not just kids. isChild stays keyed off
// role (below) since only child/teen seats use PIN login.
export const addMemberBodySchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  role: z.enum(['child', 'teen', 'adult']).default('child'),
  age: z.number().int().min(1).max(25).optional(),
  avatarEmoji: z.string().min(1).max(8).optional(),
});

export const addMemberResponseSchema = z.object({
  member: z.object({
    id: z.string().uuid(),
    displayName: z.string(),
    role: z.string(),
  }),
});

const patchMemberBodySchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    // Only the admin↔adult toggle is allowed here; kid roles are fixed
    // at creation and PIN flags have their own endpoints.
    role: z.enum(['admin', 'adult']).optional(),
  })
  .refine((b) => b.displayName !== undefined || b.role !== undefined, {
    message: 'nothing to update',
  });

async function loadAdminCaller(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  userId: string,
): Promise<{ id: string; role: string } | null> {
  const rows = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

async function countAdmins(db: ReturnType<typeof getDb>, tenantId: string): Promise<number> {
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.role, 'admin')));
  return rows.length;
}

membersRouter.post('/', async (c) => {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) throw new Error('members POST reached without userRow');
  const tenantId = c.get('tenantId');
  if (!tenantId) {
    return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
  }
  const db = getDb();
  const caller = await loadAdminCaller(db, tenantId, userRow.id);
  if (!caller) {
    return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
  }
  if (caller.role !== 'admin') {
    return c.json({ error: 'forbidden', detail: 'only admins can add members' }, 403);
  }
  const parsed = addMemberBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid request',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    );
  }
  const inserted = await db
    .insert(members)
    .values({
      tenantId,
      displayName: parsed.data.displayName,
      role: parsed.data.role,
      age: parsed.data.age ?? null,
      avatarEmoji: parsed.data.avatarEmoji ?? null,
      // FHS-473 — only child/teen seats are kid-PIN-login eligible; an
      // adult added here is a plain roster entry, same as onboarding's
      // no-email adult row.
      isChild: parsed.data.role !== 'adult',
    })
    .returning({ id: members.id, displayName: members.displayName, role: members.role });
  return c.json({ member: inserted[0] }, 201);
});

membersRouter.patch('/:id', async (c) => {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) throw new Error('members PATCH reached without userRow');
  const tenantId = c.get('tenantId');
  if (!tenantId) {
    return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
  }
  const params = memberIdParamsSchema.safeParse(c.req.param());
  if (!params.success) return c.json({ error: 'invalid member id' }, 400);
  const db = getDb();
  const caller = await loadAdminCaller(db, tenantId, userRow.id);
  if (!caller) {
    return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
  }
  if (caller.role !== 'admin') {
    return c.json({ error: 'forbidden', detail: 'only admins can edit members' }, 403);
  }
  const parsed = patchMemberBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid request',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    );
  }
  const targetRows = await db
    .select({ id: members.id, role: members.role, userId: members.userId })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.id, params.data.id)))
    .limit(1);
  const target = targetRows[0];
  if (!target) return c.json({ error: 'member not found' }, 404);

  if (parsed.data.role !== undefined) {
    // Admin toggle is parents-only: the target must already be adult/admin.
    if (target.role !== 'admin' && target.role !== 'adult') {
      return c.json(
        { error: 'forbidden', detail: 'only parents can be made or removed as admin' },
        400,
      );
    }
    // FHS-278 — no admin rights before a real login is attached: a
    // pending (unclaimed) seat can't be promoted.
    if (parsed.data.role === 'admin' && target.userId === null) {
      return c.json(
        { error: 'forbidden', detail: "they haven't signed up yet — admin comes after they join" },
        400,
      );
    }
    // An admin can't demote THEMSELF — another admin must do it, so a
    // mis-tap can't lock the family's owner out of management.
    if (target.id === caller.id && target.role === 'admin' && parsed.data.role === 'adult') {
      return c.json(
        { error: 'forbidden', detail: 'ask another admin to remove your admin access' },
        400,
      );
    }
    // Never demote the last admin.
    if (target.role === 'admin' && parsed.data.role === 'adult') {
      const admins = await countAdmins(db, tenantId);
      if (admins <= 1) {
        return c.json(
          { error: 'forbidden', detail: 'a family must always have at least one admin' },
          400,
        );
      }
    }
  }

  const updated = await db
    .update(members)
    .set({
      ...(parsed.data.displayName !== undefined ? { displayName: parsed.data.displayName } : {}),
      ...(parsed.data.role !== undefined ? { role: parsed.data.role } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(members.tenantId, tenantId), eq(members.id, params.data.id)))
    .returning({ id: members.id, displayName: members.displayName, role: members.role });
  return c.json({ member: updated[0] }, 200);
});

membersRouter.delete('/:id', async (c) => {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) throw new Error('members DELETE reached without userRow');
  const tenantId = c.get('tenantId');
  if (!tenantId) {
    return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
  }
  const params = memberIdParamsSchema.safeParse(c.req.param());
  if (!params.success) return c.json({ error: 'invalid member id' }, 400);
  const db = getDb();
  const caller = await loadAdminCaller(db, tenantId, userRow.id);
  if (!caller) {
    return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
  }
  if (caller.role !== 'admin') {
    return c.json({ error: 'forbidden', detail: 'only admins can remove members' }, 403);
  }
  const targetRows = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.id, params.data.id)))
    .limit(1);
  const target = targetRows[0];
  if (!target) return c.json({ error: 'member not found' }, 404);
  if (target.role === 'admin') {
    const admins = await countAdmins(db, tenantId);
    if (admins <= 1) {
      return c.json(
        { error: 'forbidden', detail: 'a family must always have at least one admin' },
        400,
      );
    }
  }
  await db
    .delete(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.id, params.data.id)));
  return c.json({ deleted: true }, 200);
});

// ─────────────────────────────────────────────────────────────────────────────
// FHS-510 — admin changes a grown-up's sign-in email, confirmed by a one-time
// emailed link.
//
// POST /api/members/:id/email-change          — self-serve. A member starts a
//   change of their OWN sign-in email: emails a confirm link to the NEW
//   address; the old address keeps working until it's clicked.
// POST /api/members/email-change/confirm       — PUBLIC (no auth — the
//   recipient may not be signed in). Applies the change if the token is
//   valid, unexpired, and unused.
// POST /api/members/:id/email-change/cancel    — self-serve. Drops the caller's
//   OWN pending row so they can start over.
//
// Security (do not relax without re-reading this block):
//   - The raw token is NEVER stored or logged — only its SHA-256 hash
//     (member_email_changes.token_hash).
//   - The confirm endpoint is public (see PUBLIC_PATH_PREFIXES in
//     middleware/auth.ts) but only acts on a row matched by
//     (member_id, token_hash) via the app_find_email_change() SECURITY
//     DEFINER function (0043_member_email_changes.sql) — same pattern as
//     the invite-claim flow's app_claimable_invitations(). It is single-use
//     (used_at set) and tenant-scoped from the ROW, never from client input.
//     A partial unique index (member_id WHERE used_at IS NULL) stops two
//     concurrent requests from ever creating two live rows for one member.
//   - Self-serve ONLY: a member can start or cancel a change for their OWN
//     row and no other (the start/cancel handlers 403 unless the target is
//     the caller's own member row). `email`/`pendingEmail` on GET
//     /api/members are returned ONLY for the caller's own row — a grown-up's
//     login email is not roster data other family members should see.
//   - The CURRENT (old) email is notified on start AND on completion — if a
//     hijacked session repoints the owner's own login, the real owner still
//     gets a heads-up at the old address. Both notices are best-effort: a
//     send failure is logged, never blocks or rolls back the main flow.
//   - Every value spliced into an email HTML template goes through
//     escapeHtml() first — displayName is user-controlled.
//   - New-email uniqueness is checked against `users` before the email
//     is sent.
//   - The web ConfirmEmail screen requires an explicit click before it
//     POSTs the token (never auto-fires on page load) — an email link-
//     scanner (Safe Links/Proofpoint) that prefetches the URL would
//     otherwise burn the single-use token before the real recipient sees it.
// ─────────────────────────────────────────────────────────────────────────────

export const memberEmailChangeRequestBodySchema = z.object({
  email: z.string().trim().email('enter a valid email').max(254),
});

export const memberEmailChangeRequestResponseSchema = z.object({
  pendingEmail: z.string(),
});

export type MemberEmailChangeRequestResponse = z.infer<
  typeof memberEmailChangeRequestResponseSchema
>;

const EMAIL_CHANGE_TOKEN_TTL_MS = 24 * 60 * 60_000;

// Every value below is user-controlled at some remove (displayName is set by
// an admin, emails come from the request body) — escapeHtml() on ALL of them
// is what stops a crafted name/email from injecting markup or a fake link
// into a branded, trusted-looking auth email. Never splice a raw value into
// these templates.

function emailChangeHtml(opts: {
  displayName: string;
  currentEmail: string | null;
  newEmail: string;
  confirmUrl: string;
}): string {
  // Modelled on apps/api/auth/email-templates/email_change.html (the
  // Supabase-side template for a user-initiated change) — self-serve, so the
  // recipient of this email is the person who asked for the change.
  const displayName = escapeHtml(opts.displayName);
  const currentEmail = opts.currentEmail ? escapeHtml(opts.currentEmail) : null;
  const newEmail = escapeHtml(opts.newEmail);
  const confirmUrl = escapeHtml(opts.confirmUrl);
  const fromLine = currentEmail
    ? `from <strong>${currentEmail}</strong> to <strong>${newEmail}</strong>`
    : `to <strong>${newEmail}</strong>`;
  return `
    <h1>Confirm your new email</h1>
    <p>Hi ${displayName},</p>
    <p>You asked to change your Family Hub sign-in email ${fromLine}. Confirm the change so it takes effect:</p>
    <p>
      <a href="${confirmUrl}" style="display:inline-block;padding:12px 20px;background:#1f2937;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">Confirm new email</a>
    </p>
    <p>If the button doesn't work, paste this link into your browser:</p>
    <p><a href="${confirmUrl}">${confirmUrl}</a></p>
    <p>${currentEmail ? `Your old email (${currentEmail}) keeps working until you click the link above.` : ''} If you didn't request this, you can safely ignore this email — nothing changes until this link is clicked.</p>
    <p>— The Family Hub team</p>
  `.trim();
}

// FHS-510 blocker #2 — the CURRENT (old) email is always notified, so if a
// hijacked session repoints the owner's own login, the real owner still gets a
// heads-up at the address they still control. Two notices, sent best-effort (a
// failure here never blocks or rolls back the main flow — see the call sites).

function emailChangeStartedOldEmailHtml(opts: { displayName: string; newEmail: string }): string {
  const displayName = escapeHtml(opts.displayName);
  const newEmail = escapeHtml(opts.newEmail);
  return `
    <h1>Your Family Hub sign-in email is changing</h1>
    <p>Hi ${displayName},</p>
    <p>A request was made to change your Family Hub sign-in email to <strong>${newEmail}</strong>. It only takes effect when the link sent to the new address is confirmed.</p>
    <p>If this wasn't you, don't confirm anything — change your password to secure your account.</p>
    <p>— The Family Hub team</p>
  `.trim();
}

function emailChangeCompletedOldEmailHtml(opts: { displayName: string; newEmail: string }): string {
  const displayName = escapeHtml(opts.displayName);
  const newEmail = escapeHtml(opts.newEmail);
  return `
    <h1>Your Family Hub sign-in email was changed</h1>
    <p>Hi ${displayName},</p>
    <p>Your Family Hub sign-in email was changed to <strong>${newEmail}</strong>.</p>
    <p>If this wasn't you, change your password to secure your account.</p>
    <p>— The Family Hub team</p>
  `.trim();
}

// POST /api/members/:id/email-change — self-serve: a member changes their OWN
// sign-in email (403 for any other target). See the security block above.
membersRouter.post('/:id/email-change', async (c) => {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) throw new Error('email-change handler reached without userRow');
  const tenantId = c.get('tenantId');
  if (!tenantId) {
    return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
  }
  const params = memberIdParamsSchema.safeParse(c.req.param());
  if (!params.success) return c.json({ error: 'invalid member id' }, 400);

  const db = getDb();
  const caller = await loadAdminCaller(db, tenantId, userRow.id);
  if (!caller) {
    return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
  }
  // FHS-510 — self-serve only: a member may change ONLY their OWN sign-in email
  // (never an admin changing someone else's). The self-check runs after the
  // target row is loaded (target.userId must be the caller's own user id).

  const parsed = memberEmailChangeRequestBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid request',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    );
  }

  const baseUrl = config.APP_BASE_URL;
  if (!baseUrl) {
    log.error({ tenantId }, 'APP_BASE_URL not configured — refusing to start an email change');
    return c.json({ error: 'server misconfigured', detail: 'APP_BASE_URL is required' }, 500);
  }

  const targetRows = await db
    .select({ id: members.id, userId: members.userId, displayName: members.displayName })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.id, params.data.id)))
    .limit(1);
  const target = targetRows[0];
  if (!target) return c.json({ error: 'member not found' }, 404);
  // FHS-510 — self-serve: the target must be the caller's own member row. A
  // null target.userId (unclaimed seat) can never equal the caller's own
  // non-null user id, so this also covers the "no sign-in email yet" case.
  if (target.userId !== userRow.id) {
    return c.json(
      { error: 'forbidden', detail: 'you can only change your own sign-in email' },
      403,
    );
  }

  const newEmail = parsed.data.email.toLowerCase();

  const currentUserRows = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, target.userId))
    .limit(1);
  const currentEmail = currentUserRows[0]?.email ?? null;
  if (currentEmail && currentEmail.toLowerCase() === newEmail) {
    return c.json({ error: 'invalid request', detail: 'that is already their sign-in email' }, 400);
  }

  const existingRows = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${newEmail}`)
    .limit(1);
  if (existingRows.length > 0) {
    return c.json(
      {
        error: 'email already registered',
        field: 'email',
        detail: 'That email already belongs to a Family Hub account.',
      },
      409,
    );
  }

  // Invalidate any prior unconfirmed request for this member before
  // starting a new one — at most one active row per member at a time.
  await db
    .delete(memberEmailChanges)
    .where(
      and(
        eq(memberEmailChanges.tenantId, tenantId),
        eq(memberEmailChanges.memberId, target.id),
        isNull(memberEmailChanges.usedAt),
      ),
    );

  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TOKEN_TTL_MS);

  let changeId: string;
  try {
    const inserted = await db
      .insert(memberEmailChanges)
      .values({ tenantId, memberId: target.id, newEmail, tokenHash, expiresAt })
      .returning({ id: memberEmailChanges.id });
    const insertedId = inserted[0]?.id;
    if (!insertedId) throw new Error('member_email_changes insert returned no row');
    changeId = insertedId;
  } catch (err) {
    // 23505 = unique_violation. Belt-and-braces against the delete-then-
    // insert race above: the partial unique index on (member_id) WHERE
    // used_at IS NULL (0043_member_email_changes.sql) rejects a second
    // concurrent request for the same member before either one sends mail.
    const isUniqueViolation =
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === '23505';
    if (isUniqueViolation) {
      return c.json(
        {
          error: 'a change is already pending for this member',
          detail: 'Someone else just started a change for this member. Try again in a moment.',
        },
        409,
      );
    }
    throw err;
  }

  const confirmUrl = `${baseUrl.replace(/\/$/, '')}/confirm-email/${target.id}?token=${rawToken}`;
  const result = await sendEmail({
    to: newEmail,
    subject: 'Confirm your new Family Hub email',
    html: emailChangeHtml({
      displayName: target.displayName,
      currentEmail,
      newEmail,
      confirmUrl,
    }),
  });

  if (!result.ok) {
    // Roll back — an unconfirmable pending row would silently block a retry
    // and show the wrong "pendingEmail" on the family roster.
    await db.delete(memberEmailChanges).where(eq(memberEmailChanges.id, changeId));
    log.error(
      { tenantId, memberId: target.id, err: result.error },
      'email-change: send failed; rolled back',
    );
    return c.json(
      {
        error: 'could not send confirmation email',
        detail: "We couldn't send the confirmation email right now. Please try again in a moment.",
      },
      502,
    );
  }

  // FHS-510 blocker #2 — heads-up the OLD address. Best-effort: a send
  // failure here is logged but never fails the request or rolls back the
  // pending row — the primary flow (new-address confirm link) already sent.
  if (currentEmail) {
    const notifyResult = await sendEmail({
      to: currentEmail,
      subject: 'Your Family Hub sign-in email is changing',
      html: emailChangeStartedOldEmailHtml({ displayName: target.displayName, newEmail }),
    });
    if (!notifyResult.ok) {
      log.error(
        { tenantId, memberId: target.id, err: notifyResult.error },
        'email-change: old-address heads-up notice failed to send (non-fatal)',
      );
    }
  }

  log.info({ tenantId, memberId: target.id, adminId: userRow.id }, 'email change requested');
  return c.json(memberEmailChangeRequestResponseSchema.parse({ pendingEmail: newEmail }), 200);
});

// POST /api/members/:id/email-change/cancel — self-only.
membersRouter.post('/:id/email-change/cancel', async (c) => {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) throw new Error('email-change/cancel handler reached without userRow');
  const tenantId = c.get('tenantId');
  if (!tenantId) {
    return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
  }
  const params = memberIdParamsSchema.safeParse(c.req.param());
  if (!params.success) return c.json({ error: 'invalid member id' }, 400);

  const db = getDb();
  const caller = await loadAdminCaller(db, tenantId, userRow.id);
  if (!caller) {
    return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
  }
  // FHS-510 — self-serve: you can only cancel your OWN pending email change.
  if (params.data.id !== caller.id) {
    return c.json({ error: 'forbidden', detail: 'you can only cancel your own email change' }, 403);
  }

  await db
    .delete(memberEmailChanges)
    .where(
      and(
        eq(memberEmailChanges.tenantId, tenantId),
        eq(memberEmailChanges.memberId, params.data.id),
        isNull(memberEmailChanges.usedAt),
      ),
    );
  return c.json({ cancelled: true }, 200);
});

export const confirmEmailChangeBodySchema = z.object({
  memberId: z.string().uuid('memberId must be a UUID'),
  token: z.string().min(1, 'token is required'),
});

export const confirmEmailChangeResponseSchema = z.object({
  newEmail: z.string(),
  memberName: z.string(),
  tenantSlug: z.string().nullable(),
});

export type ConfirmEmailChangeResponse = z.infer<typeof confirmEmailChangeResponseSchema>;

// POST /api/members/email-change/confirm — PUBLIC. See PUBLIC_PATH_PREFIXES
// in middleware/auth.ts. The recipient may not be signed in at all, so this
// handler must never call getAuthenticatedUser — the token IS the
// credential.
membersRouter.post('/email-change/confirm', async (c) => {
  const db = getDb();
  const parsed = confirmEmailChangeBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid request',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    );
  }

  const tokenHash = createHash('sha256').update(parsed.data.token).digest('hex');

  // SECURITY DEFINER lookup (0043_member_email_changes.sql) — this request
  // has no tenant pinned yet (public route), so a plain SELECT against the
  // RLS-guarded table would return zero rows. Scoped to (member_id,
  // token_hash): only someone holding the emailed link's high-entropy raw
  // token gets a hit.
  const { rows } = await db.execute<{
    id: string;
    tenant_id: string;
    member_id: string;
    new_email: string;
    expires_at: Date;
    used_at: Date | null;
  }>(
    sql`select id, tenant_id, member_id, new_email, expires_at, used_at
        from app_find_email_change(${parsed.data.memberId}, ${tokenHash})`,
  );
  const row = rows[0];
  if (!row || row.used_at !== null || new Date(row.expires_at).getTime() < Date.now()) {
    return c.json({ error: 'expired' }, 410);
  }

  // Now that we know the row's tenant, pin it so the writes below (which run
  // through the normal RLS-guarded tables) pass tenant_isolation.
  await pinRequestTenant(row.tenant_id);

  const targetRows = await db
    .select({ id: members.id, userId: members.userId, displayName: members.displayName })
    .from(members)
    .where(and(eq(members.tenantId, row.tenant_id), eq(members.id, row.member_id)))
    .limit(1);
  const target = targetRows[0];
  if (!target || !target.userId) {
    // The member was removed, or unlinked from their login, since the
    // change was requested — treat exactly like an expired link.
    return c.json({ error: 'expired' }, 410);
  }
  // FHS-510 blocker #2 — capture the OLD email BEFORE anything mutates it,
  // for the completion heads-up notice sent below on success.
  const oldUserRows = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, target.userId))
    .limit(1);
  const oldEmail = oldUserRows[0]?.email ?? null;

  try {
    await updateUserEmailById(target.userId, row.new_email);
  } catch (err) {
    // Nothing was persisted anywhere yet (Supabase itself rejected the
    // change), so the token is still valid — this is a transient failure,
    // NOT an expired link. errorCode lets the frontend tell the two apart.
    log.error(
      {
        tenantId: row.tenant_id,
        memberId: row.member_id,
        err: err instanceof Error ? err.message : String(err),
      },
      'email-change confirm: Supabase admin update failed',
    );
    return c.json(
      {
        error: 'could not update email',
        errorCode: 'EMAIL_CHANGE_APPLY_FAILED',
        detail: 'Please try the link again in a moment.',
      },
      502,
    );
  }

  // FHS-510 blocker #3 — Supabase now has the new email. If the local apply
  // below throws, the account is in a DRIFTED state (Supabase changed, our
  // mirror + used_at did not) — that must be logged distinctly and reported
  // to the user as a retryable failure, never silently re-shown as
  // "expired" (which would wrongly suggest nothing happened and the token
  // is dead, when the token may still be safely retryable).
  try {
    await db.transaction(async (tx) => {
      // FHS-349 — users carries self-scoped RLS keyed on app.current_user;
      // pin it transaction-locally so this UPDATE passes (same pattern as
      // getOrCreateUser in lib/user-mirror.ts).
      await tx.execute(sql`select set_config('app.current_user', ${target.userId}, true)`);
      await tx
        .update(users)
        .set({ email: row.new_email, updatedAt: new Date() })
        .where(eq(users.id, target.userId as string));
      // Mark every unused row for this member as consumed — normally just
      // this one, but this stays correct even if a stray row ever exists.
      await tx
        .update(memberEmailChanges)
        .set({ usedAt: new Date() })
        .where(
          and(eq(memberEmailChanges.memberId, row.member_id), isNull(memberEmailChanges.usedAt)),
        );
    });
  } catch (err) {
    log.error(
      {
        tenantId: row.tenant_id,
        memberId: row.member_id,
        userId: target.userId,
        err: err instanceof Error ? err.message : String(err),
      },
      'email-change confirm: DRIFT — Supabase email updated but the local apply (users mirror / used_at) failed',
    );
    return c.json(
      {
        error: 'apply failed',
        errorCode: 'EMAIL_CHANGE_APPLY_FAILED',
        detail: 'Something went wrong applying the change. Please try the link again in a moment.',
      },
      500,
    );
  }

  const tenantRows = await db
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, row.tenant_id))
    .limit(1);

  // FHS-510 blocker #2 — completion heads-up to the OLD address.
  // Best-effort: logged, never blocks the (already-successful) response.
  if (oldEmail) {
    const notifyResult = await sendEmail({
      to: oldEmail,
      subject: 'Your Family Hub sign-in email was changed',
      html: emailChangeCompletedOldEmailHtml({
        displayName: target.displayName,
        newEmail: row.new_email,
      }),
    });
    if (!notifyResult.ok) {
      log.error(
        { tenantId: row.tenant_id, memberId: row.member_id, err: notifyResult.error },
        'email-change confirm: old-address completion notice failed to send (non-fatal)',
      );
    }
  }

  log.info({ tenantId: row.tenant_id, memberId: row.member_id }, 'email change confirmed');
  return c.json(
    confirmEmailChangeResponseSchema.parse({
      newEmail: row.new_email,
      memberName: target.displayName,
      tenantSlug: tenantRows[0]?.slug ?? null,
    }),
    200,
  );
});
