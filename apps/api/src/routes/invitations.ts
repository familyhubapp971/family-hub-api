import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb, pinRequestTenant } from '../db/client.js';
import { members, pendingInvitations, tenants, type PendingInvitation } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import {
  inviteUserByEmail,
  isEmailAlreadyRegisteredError,
  SupabaseAdminError,
} from '../lib/supabase-admin.js';
import { createLogger } from '../logger.js';

// FHS-91: POST /api/invitations.
//
// Sends a Supabase magic-link invite to an email address and records
// the outstanding invite in `pending_invitations`. The redemption
// endpoint (FHS-92) will flip status → 'accepted' and create a real
// `members` row when the invitee clicks the link and signs in.
//
// Authorization model:
//   - Caller must be authenticated (auth middleware).
//   - Caller must be a member of the resolved tenant (resolveTenant
//     middleware sets c.var.tenantId from JWT/subdomain/path).
//   - Caller's role must be `admin` or `adult`: kids can't invite.
//   - FHS-486: inviting someone as `role: 'admin'` additionally requires
//     the caller to already be an admin (403 otherwise). See ADR 0019.
//
// Rate limiting (10 invites/hour/tenant) is FHS-95's job; the global
// rate-limit middleware still applies per-IP.

const log = createLogger('invitations');

// Subset of memberRole that callers are allowed to assign on invite.
// FHS-486 / ADR 0019: `admin` IS invitable (a co-parent can be invited
// as a full admin), but only an admin caller may grant it: see the
// admin-grant safeguard below. Inviting someone as `child` still doesn't
// make sense in the magic-link flow because kids use the PIN auth path
// (ADR 0009 / FHS-234).
const INVITE_ROLE_VALUES = ['admin', 'adult', 'teen', 'guest'] as const;
const inviteRoleSchema = z.enum(INVITE_ROLE_VALUES);

export const createInvitationRequestSchema = z.object({
  email: z.string().email('enter a valid email').max(254),
  role: inviteRoleSchema.default('adult'),
  // FHS-276: optional: create the member seat now (named card shows as
  // pending immediately); claim links the login to THIS seat.
  displayName: z.string().trim().min(1).max(80).optional(),
});

export const createInvitationResponseSchema = z.object({
  invitation: z.object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    email: z.string(),
    role: z.string(),
    status: z.string(),
    createdAt: z.string().datetime(),
  }),
});

export type CreateInvitationResponse = z.infer<typeof createInvitationResponseSchema>;

function project(row: PendingInvitation): CreateInvitationResponse {
  return {
    invitation: {
      id: row.id,
      tenantId: row.tenantId,
      email: row.email,
      role: row.role,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    },
  };
}

export const invitationsRouter = new Hono().post('/', async (c) => {
  // Auth + tenant context: both middlewares must have run.
  // getAuthenticatedUser throws if auth was bypassed: that's the
  // contract that lets us assume `userRow` is set below.
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) {
    // Unreachable in the production wiring (auth middleware upserts
    // the mirror row on every request), but the explicit guard keeps
    // the "I forgot to mount the user-mirror-sync option" mistake
    // loud during development.
    throw new Error('invitations handler reached without userRow on context');
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
  // Fail fast on missing config BEFORE we INSERT a pending row: a
  // 500 here would otherwise leave an orphan `pending` row that
  // blocks retries until manually cleaned.
  const baseUrl = config.APP_BASE_URL;
  if (!baseUrl) {
    log.error({ tenantId }, 'APP_BASE_URL not configured: refusing to create pending invite');
    return c.json({ error: 'server misconfigured', detail: 'APP_BASE_URL is required' }, 500);
  }

  // Authorization: caller must be a member of the tenant with an
  // invite-capable role. One indexed lookup against members(tenant_id, user_id).
  const db = getDb();
  const callerRows = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.userId, userRow.id)))
    .limit(1);
  const caller = callerRows[0];
  if (!caller) {
    return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
  }
  if (caller.role !== 'admin' && caller.role !== 'adult') {
    return c.json(
      { error: 'forbidden', detail: 'role not permitted to invite (need admin or adult)' },
      403,
    );
  }

  // Validate body.
  const body = await c.req.json().catch(() => null);
  const parsed = createInvitationRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid request',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    );
  }

  // FHS-486 / ADR 0019: admin-grant safeguard: a non-admin adult can
  // invite everyday roles, but only an existing admin may grant `admin`
  // on the invite. Without this a normal user could hand out full rights
  // by inviting someone as admin: exactly the escalation ADR 0015 closed
  // for the /api/members role PATCH.
  if (parsed.data.role === 'admin' && caller.role !== 'admin') {
    return c.json({ error: 'forbidden', detail: 'only an admin can invite someone as admin' }, 403);
  }

  const email = parsed.data.email.trim().toLowerCase();
  const role = parsed.data.role;

  // Insert the pending row first. The partial unique index
  // (pending_invitations_tenant_email_pending_uniq) catches
  // double-invite races at insert time.
  let invitation: PendingInvitation;
  // FHS-276: when the caller named the seat, create the member row up
  // front so the Manage Members grid shows a pending card immediately.
  let seatMemberId: string | null = null;
  if (parsed.data.displayName) {
    const seat = await db
      .insert(members)
      .values({ tenantId, displayName: parsed.data.displayName, role })
      .returning({ id: members.id });
    seatMemberId = seat[0]?.id ?? null;
  }

  try {
    const inserted = await db
      .insert(pendingInvitations)
      .values({
        tenantId,
        email,
        role,
        invitedBy: caller.id,
        memberId: seatMemberId,
        status: 'pending',
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('pending_invitations insert returned no row');
    invitation = row;
  } catch (err) {
    const isUniqueViolation =
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === '23505';
    if (isUniqueViolation) {
      return c.json(
        {
          error: 'invitation already pending',
          field: 'email',
          email,
        },
        409,
      );
    }
    log.error({ err, tenantId, email }, 'pending_invitations insert failed');
    throw err;
  }

  // Now ask Supabase to actually send the email. If this fails we
  // mark the row as 'expired' so a retry creates a fresh pending row
  // rather than tripping the unique index.
  //
  // KNOWN GAP: if the process dies between the INSERT above and the
  // Supabase call below, the pending row sits forever and blocks
  // re-invites. Reconciliation job (cron that expires `pending` rows
  // older than N minutes with no `supabase_invite_id`) is filed
  // separately under FHS-205: not blocking for v1 since the failure
  // mode is rare and recoverable by an admin.
  const redirectTo = `${baseUrl.replace(/\/$/, '')}/auth/callback?invite=${invitation.id}`;

  try {
    const supabaseUser = await inviteUserByEmail({
      email,
      redirectTo,
      data: {
        invite_id: invitation.id,
        tenant_id: tenantId,
        role,
      },
    });
    await db
      .update(pendingInvitations)
      .set({ supabaseInviteId: supabaseUser.id, updatedAt: new Date() })
      .where(eq(pendingInvitations.id, invitation.id));
    invitation = { ...invitation, supabaseInviteId: supabaseUser.id };
  } catch (err) {
    // FHS-352: roll back the failed attempt so it never leaves a ghost
    // "pending" member on the dashboard. When a named seat was created, delete
    // it: `pending_invitations.member_id` is ON DELETE CASCADE, so that one
    // delete also removes the linked invitation (the brand-new, unclaimed seat
    // is safe to drop). With no seat, just expire the pending row (kept for the
    // audit trail; lets a retry create a fresh one). Wrapped so a cleanup
    // failure can't mask the original error.
    try {
      if (seatMemberId) {
        await db.delete(members).where(eq(members.id, seatMemberId));
      } else {
        await db
          .update(pendingInvitations)
          .set({ status: 'expired', updatedAt: new Date() })
          .where(eq(pendingInvitations.id, invitation.id));
      }
    } catch (cleanupErr) {
      log.error(
        { err: cleanupErr, seatMemberId, invitationId: invitation.id, tenantId },
        'invite rollback cleanup failed',
      );
    }

    // The email already has a Family Hub account: Supabase admin invite rejects
    // it. Surface a clear, actionable 409 instead of a confusing 502.
    if (isEmailAlreadyRegisteredError(err)) {
      log.info({ tenantId, email }, 'invite skipped: email already registered');
      return c.json(
        {
          error: 'email already registered',
          field: 'email',
          email,
          detail:
            'That email already has a Family Hub account. Ask them to sign in: they can join this family from their invites.',
        },
        409,
      );
    }

    const status =
      err instanceof SupabaseAdminError ? `supabase ${err.status}` : 'admin call failed';
    log.error(
      {
        err: err instanceof Error ? err.message : String(err),
        invitationId: invitation.id,
        tenantId,
      },
      `invite send failed (${status}); rolled back seat + expired row`,
    );
    return c.json(
      {
        error: 'invitation could not be sent',
        detail: "We couldn't send the invite right now. Please try again in a moment.",
      },
      502,
    );
  }

  log.info(
    { invitationId: invitation.id, tenantId, email, role, invitedBy: caller.id },
    'invitation sent',
  );

  return c.json(createInvitationResponseSchema.parse(project(invitation)), 201);
});

// FHS-275: POST /api/invitations/claim.
//
// Called by the web app right after sign-in when the user has no
// membership yet. Finds pending invitations addressed to the caller's
// email that are linked to an unclaimed member seat (member_id set,
// members.user_id null), links the seat to the caller, flips the
// invitation to accepted, and returns the claimed tenants' slugs so
// the client can land on the right family dashboard. No tenant header
// required: the invitation rows themselves carry the tenant scope.
export const invitationClaimRouter = new Hono().post('/', async (c) => {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) throw new Error('claim handler reached without userRow');
  const db = getDb();

  // FHS-354: a deliberately cross-tenant read (find every family that invited
  // this email; the claimer has no membership yet). Goes through the SECURITY
  // DEFINER function so it works once the app runs as app_runtime: a plain
  // pending_invitations read would return zero rows under RLS with no tenant
  // pinned.
  const { rows: pending } = await db.execute<{
    id: string;
    tenant_id: string;
    member_id: string | null;
    role: (typeof INVITE_ROLE_VALUES)[number];
  }>(sql`select id, tenant_id, member_id, role
         from app_claimable_invitations(${userRow.email})`);

  const claimed: Array<{ tenantId: string; slug: string }> = [];
  for (const row of pending) {
    const inv = {
      id: row.id,
      tenantId: row.tenant_id,
      memberId: row.member_id,
      role: row.role,
    };
    // FHS-354: pin this invite's tenant so the writes below (flip the
    // invitation, create/link the member: both RLS-scoped) pass once the app
    // runs as app_runtime. Each iteration re-pins its own tenant.
    await pinRequestTenant(inv.tenantId);
    // FHS-276: members-page invites carry no pre-created seat: create
    // the member row at claim time instead (display name from the email
    // local-part; rename later on Manage Members).
    if (!inv.memberId) {
      // Flip the invitation FIRST with a status guard so two concurrent
      // claims can't both create a member row (only one wins the flip).
      const flipped = await db
        .update(pendingInvitations)
        .set({ status: 'accepted', updatedAt: new Date() })
        .where(and(eq(pendingInvitations.id, inv.id), eq(pendingInvitations.status, 'pending')))
        .returning({ id: pendingInvitations.id });
      if (!flipped[0]) continue;
      const local = (userRow.email.split('@')[0] ?? '').trim();
      const display = local ? local.charAt(0).toUpperCase() + local.slice(1) : 'Parent';
      const created = await db
        .insert(members)
        .values({
          tenantId: inv.tenantId,
          userId: userRow.id,
          displayName: display,
          role: inv.role,
        })
        .returning({ id: members.id });
      if (!created[0]) continue;
      const trows0 = await db
        .select({ slug: tenants.slug })
        .from(tenants)
        .where(eq(tenants.id, inv.tenantId))
        .limit(1);
      if (trows0[0]) claimed.push({ tenantId: inv.tenantId, slug: trows0[0].slug });
      log.info(
        { invitationId: inv.id, tenantId: inv.tenantId, memberId: created[0].id },
        'invitation claimed (seat created)',
      );
      continue;
    }
    // Claim only an unclaimed seat in the invite's own tenant.
    const updatedRows = await db
      .update(members)
      .set({ userId: userRow.id, updatedAt: new Date() })
      .where(
        and(
          eq(members.id, inv.memberId),
          eq(members.tenantId, inv.tenantId),
          isNull(members.userId),
        ),
      )
      .returning({ id: members.id });
    if (updatedRows.length === 0) continue; // seat gone or already claimed
    await db
      .update(pendingInvitations)
      .set({ status: 'accepted', updatedAt: new Date() })
      .where(eq(pendingInvitations.id, inv.id));
    const trows = await db
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, inv.tenantId))
      .limit(1);
    if (trows[0]) claimed.push({ tenantId: inv.tenantId, slug: trows[0].slug });
    log.info(
      { invitationId: inv.id, tenantId: inv.tenantId, memberId: inv.memberId },
      'invitation claimed',
    );
  }

  return c.json({ claimed }, 200);
});

// FHS-276: POST /api/invitations/:id/resend.
//
// Re-fires the Supabase invite email for a still-pending invitation
// (typo'd address fixed at the provider, email lost, etc.). Admin or
// adult caller, same tenant. The invitation row keeps its id/seat link
// so a later claim still lands on the right member.
export const invitationResendRouter = new Hono().post('/:id/resend', async (c) => {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) throw new Error('resend handler reached without userRow');
  const tenantId = c.get('tenantId');
  if (!tenantId) {
    return c.json({ error: 'tenant context required', errorCode: 'TENANT_REQUIRED' }, 400);
  }
  const id = c.req.param('id');
  if (!z.string().uuid().safeParse(id).success) {
    return c.json({ error: 'invalid invitation id' }, 400);
  }
  const db = getDb();
  const callerRows = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.userId, userRow.id)))
    .limit(1);
  const caller = callerRows[0];
  if (!caller) {
    return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
  }
  if (caller.role !== 'admin' && caller.role !== 'adult') {
    return c.json({ error: 'forbidden', detail: 'role not permitted to resend invites' }, 403);
  }
  const invRows = await db
    .select({
      id: pendingInvitations.id,
      email: pendingInvitations.email,
      status: pendingInvitations.status,
    })
    .from(pendingInvitations)
    .where(and(eq(pendingInvitations.tenantId, tenantId), eq(pendingInvitations.id, id)))
    .limit(1);
  const inv = invRows[0];
  if (!inv) return c.json({ error: 'invitation not found' }, 404);
  if (inv.status !== 'pending') {
    return c.json({ error: 'invitation is not pending', status: inv.status }, 409);
  }
  const baseUrl = config.APP_BASE_URL;
  if (!baseUrl) {
    return c.json({ error: 'server misconfigured', detail: 'APP_BASE_URL is required' }, 500);
  }
  try {
    const supabaseUser = await inviteUserByEmail({
      email: inv.email,
      redirectTo: `${baseUrl.replace(/\/$/, '')}/auth/callback?invite=${inv.id}`,
      data: { invite_id: inv.id, tenant_id: tenantId },
    });
    await db
      .update(pendingInvitations)
      .set({ supabaseInviteId: supabaseUser.id, updatedAt: new Date() })
      .where(eq(pendingInvitations.id, inv.id));
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), invitationId: inv.id, tenantId },
      'invite resend failed',
    );
    return c.json({ error: 'invitation could not be resent' }, 502);
  }
  return c.json({ resent: true }, 200);
});
