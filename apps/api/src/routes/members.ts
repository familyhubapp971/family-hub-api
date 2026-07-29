import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/client.js';
import { members, pendingInvitations } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { KID_PIN_BCRYPT_COST, resetKidPinBucketForMember } from './auth-kid-pin.js';

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
});

export const listMembersResponseSchema = z.object({
  members: z.array(memberItemSchema),
  // FHS-252 — caller's role in this tenant. Lets the members page
  // gate admin-only affordances (set/reset kid PIN) without a second
  // round-trip. Cheap to compute server-side; the auth check
  // already loaded the row.
  callerRole: z.string(),
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
      };
    }),
    callerRole,
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
