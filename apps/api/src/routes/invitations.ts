import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { members, pendingInvitations, type PendingInvitation } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { inviteUserByEmail, SupabaseAdminError } from '../lib/supabase-admin.js';
import { createLogger } from '../logger.js';

// FHS-91 — POST /api/invitations.
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
//   - Caller's role must be `admin` or `adult` — kids can't invite.
//
// Rate limiting (10 invites/hour/tenant) is FHS-95's job; the global
// rate-limit middleware still applies per-IP.

const log = createLogger('invitations');

// Subset of memberRole that callers are allowed to assign on invite.
// Admins shouldn't be able to grant `admin` via the invite flow — that
// requires a separate promotion path (deferred). Likewise, inviting
// someone as `child` doesn't make sense in the magic-link flow because
// kids use the PIN auth path (ADR 0009 / FHS-234).
const INVITE_ROLE_VALUES = ['adult', 'teen', 'guest'] as const;
const inviteRoleSchema = z.enum(INVITE_ROLE_VALUES);

export const createInvitationRequestSchema = z.object({
  email: z.string().email('enter a valid email').max(254),
  role: inviteRoleSchema.default('adult'),
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
  // getAuthenticatedUser throws if auth was bypassed — that's the
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
  // Fail fast on missing config BEFORE we INSERT a pending row — a
  // 500 here would otherwise leave an orphan `pending` row that
  // blocks retries until manually cleaned.
  const baseUrl = config.APP_BASE_URL;
  if (!baseUrl) {
    log.error({ tenantId }, 'APP_BASE_URL not configured — refusing to create pending invite');
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

  const email = parsed.data.email.trim().toLowerCase();
  const role = parsed.data.role;

  // Insert the pending row first. The partial unique index
  // (pending_invitations_tenant_email_pending_uniq) catches
  // double-invite races at insert time.
  let invitation: PendingInvitation;
  try {
    const inserted = await db
      .insert(pendingInvitations)
      .values({
        tenantId,
        email,
        role,
        invitedBy: caller.id,
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
  // separately under FHS-205 — not blocking for v1 since the failure
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
    // Mark pending row as expired so the operator can retry without
    // tripping the partial-unique index. Don't delete — we want the
    // audit trail of attempted invites.
    await db
      .update(pendingInvitations)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(eq(pendingInvitations.id, invitation.id));

    const status =
      err instanceof SupabaseAdminError ? `supabase ${err.status}` : 'admin call failed';
    log.error(
      {
        err: err instanceof Error ? err.message : String(err),
        invitationId: invitation.id,
        tenantId,
      },
      `invite send failed (${status}); marked expired`,
    );
    return c.json(
      {
        error: 'invitation could not be sent',
        detail: 'Supabase admin invite failed; row marked expired',
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
