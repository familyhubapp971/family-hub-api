import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/client.js';
import { members } from '../db/schema.js';
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
    })
    .from(members)
    .where(eq(members.tenantId, tenantId))
    .orderBy(asc(members.createdAt));

  const response: ListMembersResponse = {
    members: rows.map((r) => {
      const status: MemberStatus = r.userId ? 'active' : 'unclaimed';
      return {
        id: r.id,
        displayName: r.displayName,
        role: r.role,
        avatarEmoji: r.avatarEmoji,
        status,
        createdAt: r.createdAt.toISOString(),
        isChild: r.isChild,
        hasPin: r.pinHash !== null,
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
