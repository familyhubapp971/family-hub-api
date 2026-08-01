import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { members, memberRole, pendingInvitations, tenants, type Tenant } from '../db/schema.js';
import { inviteUserByEmail } from '../lib/supabase-admin.js';
import { config } from '../config.js';
import { seedTenantDefaults } from '../db/seed-tenant-defaults.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { createLogger } from '../logger.js';

// FHS-37 — POST /api/onboarding/complete.
//
// Called by the FHS-36 OnboardingWizard on its final step. Atomic
// commit of everything the wizard collected in local state:
//   - tenant.timezone (IANA TZ string from the picker — FHS-38)
//   - tenant.currency (ISO 4217 from the picker — FHS-39)
//   - one members row per family member added in step 2 (1–8 members,
//     each with name + role + optional emoji; child rows may also carry
//     an optional age — FHS-487)
//   - tenant.onboarding_completed = true (guards the route from being
//     rendered a second time)
//
// Authorization: caller must be a member of the resolved tenant with
// admin role. Onboarding is the founding-admin's job — secondary
// adults shouldn't be re-running it.
//
// Default seeding (habits, rewards, meals) is FHS-40's job and runs
// from a separate post-completion hook.

const log = createLogger('onboarding');

// IANA TZ — loose validation. Anything matching the canonical
// `Region/City` shape (with optional secondary segments) is accepted.
// Real validation against Intl.supportedValuesOf('timeZone') happens
// client-side; the backend just rejects obvious garbage.
const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_+\-/]*$/, 'invalid IANA timezone string');

// ISO 4217 currency — three uppercase letters.
const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code');

// Subset of memberRole valid as a wizard-time selection. Admin is
// implicit (the founder is already admin via /api/public/tenant); the
// wizard never invites admins. Child/teen/adult/guest are the choices
// the user picks per added member.
const wizardMemberRoleSchema = z.enum(memberRole.enumValues);

const wizardMemberSchema = z
  .object({
    displayName: z.string().min(1).max(80),
    role: wizardMemberRoleSchema,
    avatarEmoji: z.string().min(1).max(8).optional(),
    // FHS-275 — optional invite email; adults only (kids use PIN login).
    email: z.string().trim().email().max(255).optional(),
    // FHS-487 — optional age in years for kids (child or teen). Same bound as
    // the Manage Members "Add a child" form (1–25). The UI only surfaces this
    // on kid rows; the API enforces that at insert time (see newMemberRows
    // below) so an age submitted for a grown-up role is dropped, not persisted.
    age: z.number().int().min(1).max(25).optional().nullable(),
  })
  .refine((m) => m.email === undefined || m.role === 'adult', {
    message: 'invite email is only allowed on adult members',
    path: ['email'],
  });

export const completeOnboardingRequestSchema = z
  .object({
    timezone: timezoneSchema,
    currency: currencySchema,
    // FHS-274 — the founder's own name. Renames the calling admin's member
    // row so the wizard never inserts a duplicate person for them. Trimmed
    // BEFORE the min-length check so whitespace-only values 400 instead of
    // silently skipping the rename.
    yourName: z.string().trim().min(1).max(80).optional(),
    // The OTHER family members (the founder is excluded — they already
    // exist as the admin row). A solo parent can finish with none.
    members: z.array(wizardMemberSchema).min(0).max(8),
  })
  .refine(
    (b) => {
      const emails = b.members.flatMap((m) => (m.email ? [m.email.toLowerCase()] : []));
      return new Set(emails).size === emails.length;
    },
    {
      message: 'each invite email can only be used once',
      path: ['members'],
    },
  );

export const completeOnboardingResponseSchema = z.object({
  tenant: z.object({
    id: z.string().uuid(),
    timezone: z.string(),
    currency: z.string(),
    onboardingCompleted: z.literal(true),
  }),
  membersAdded: z.number().int().nonnegative(),
  // FHS-275 — how many adult invites were emailed on Finish.
  invitesSent: z.number().int().nonnegative(),
});

export type CompleteOnboardingResponse = z.infer<typeof completeOnboardingResponseSchema>;

function project(
  tenant: Tenant,
  membersAdded: number,
  invitesSent: number,
): CompleteOnboardingResponse {
  return {
    tenant: {
      id: tenant.id,
      timezone: tenant.timezone,
      currency: tenant.currency,
      onboardingCompleted: true,
    },
    membersAdded,
    invitesSent,
  };
}

export const onboardingRouter = new Hono().post('/complete', async (c) => {
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) {
    throw new Error('onboarding handler reached without userRow on context');
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

  // Authorization: only the founding admin (or any admin) finishes
  // onboarding. Adults could in principle, but we want a single
  // source of truth — the same person who created the tenant.
  const callerRows = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.userId, userRow.id)))
    .limit(1);
  const caller = callerRows[0];
  if (!caller) {
    return c.json({ error: 'forbidden', detail: 'caller is not a member of this tenant' }, 403);
  }
  if (caller.role !== 'admin') {
    return c.json(
      { error: 'forbidden', detail: 'only the family admin can complete onboarding' },
      403,
    );
  }

  const body = await c.req.json().catch(() => null);
  const parsed = completeOnboardingRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid request',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    );
  }

  // FHS-275 — the founder can't invite themselves; their login is
  // already linked to the admin seat.
  if (
    parsed.data.members.some(
      (m) => m.email && m.email.toLowerCase() === userRow.email.toLowerCase(),
    )
  ) {
    return c.json(
      { error: 'invalid request', detail: "you can't invite your own email — that's you" },
      400,
    );
  }

  // Idempotency: if the flag is already true, return 200 with the
  // current tenant without re-inserting members. The wizard's final
  // submit can race with a tab refresh; a second click shouldn't
  // duplicate the family.
  const currentRows = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const current = currentRows[0];
  if (!current) {
    return c.json({ error: 'tenant not found' }, 404);
  }
  if (current.onboardingCompleted) {
    // Read-only by design: a duplicate submit (tab refresh race) changes
    // nothing — including yourName. Renames after onboarding belong to
    // the members page (FHS-276), not a replayed wizard call.
    return c.json(completeOnboardingResponseSchema.parse(project(current, 0, 0)), 200);
  }

  // Single transaction: members insert + tenant update + starter
  // content seed (FHS-40) all commit together. Partial failure rolls
  // back the whole onboarding so the family doesn't end up in a
  // half-onboarded state.
  let updatedTenant: Tenant | undefined;
  let membersAdded = 0;
  const inviteTargets: Array<{ memberId: string; email: string }> = [];
  let seedHabitsAdded = 0;
  let seedRewardsAdded = 0;
  try {
    await db.transaction(async (tx) => {
      // FHS-274 — the founder IS the admin row created at family
      // creation; the wizard renames them rather than duplicating them.
      const yourName = parsed.data.yourName?.trim();
      if (yourName) {
        await tx
          .update(members)
          .set({ displayName: yourName, updatedAt: new Date() })
          .where(and(eq(members.id, caller.id), eq(members.tenantId, tenantId)));
      }

      const newMemberRows = parsed.data.members.map((m) => ({
        tenantId,
        displayName: m.displayName,
        role: m.role,
        avatarEmoji: m.avatarEmoji ?? null,
        // FHS-487 — only kid rows (child/teen) persist an age; grown-up roles
        // always get null, even if a crafted request sends one.
        age: m.role === 'child' || m.role === 'teen' ? (m.age ?? null) : null,
      }));
      if (newMemberRows.length > 0) {
        const inserted = await tx
          .insert(members)
          .values(newMemberRows)
          .returning({ id: members.id });
        membersAdded = inserted.length;
        // RETURNING preserves input order for a single INSERT, so index
        // i maps the created seat back to its wizard row (for invites).
        inserted.forEach((row, i) => {
          const email = parsed.data.members[i]?.email;
          if (email) inviteTargets.push({ memberId: row.id, email });
        });
      }

      const updated = await tx
        .update(tenants)
        .set({
          timezone: parsed.data.timezone,
          currency: parsed.data.currency,
          onboardingCompleted: true,
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, tenantId))
        .returning();
      const t = updated[0];
      if (!t) throw new Error('tenant update returned no row');
      updatedTenant = t;

      // FHS-40 — seed starter habits + rewards (empty meal template
      // by design). Idempotency is upstream: this branch only runs
      // when onboarding_completed was false, so the seed never fires
      // twice for the same tenant.
      const seeded = await seedTenantDefaults(tx, tenantId);
      seedHabitsAdded = seeded.habitsAdded;
      seedRewardsAdded = seeded.rewardsAdded;
    });
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), tenantId },
      'onboarding/complete transaction failed',
    );
    throw err;
  }

  if (!updatedTenant) {
    // Unreachable: the transaction throws when the update returns no
    // row, so this branch only exists to convince TS that the value
    // is set after the try.
    throw new Error('onboarding transaction completed without setting updatedTenant');
  }

  // FHS-275 — best-effort invite emails AFTER the commit: a failed email
  // must not roll back the family. Each invite is linked to its member
  // seat; the claim flow (POST /api/invitations/claim) sets user_id on
  // that seat at the invitee's first sign-in. Failures are marked
  // expired so Manage Members (FHS-276) can resend.
  let invitesSent = 0;
  const baseUrl = config.APP_BASE_URL;
  for (const target of inviteTargets) {
    if (!baseUrl) {
      log.error({ tenantId }, 'APP_BASE_URL not configured — skipping onboarding invites');
      break;
    }
    let inviteId: string | null = null;
    try {
      const ins = await db
        .insert(pendingInvitations)
        .values({
          tenantId,
          email: target.email,
          role: 'adult',
          invitedBy: caller.id,
          memberId: target.memberId,
          status: 'pending',
        })
        .returning({ id: pendingInvitations.id });
      inviteId = ins[0]?.id ?? null;
      if (!inviteId) throw new Error('pending_invitations insert returned no row');
      const supabaseUser = await inviteUserByEmail({
        email: target.email,
        redirectTo: `${baseUrl.replace(/\/$/, '')}/auth/callback?invite=${inviteId}`,
        data: { invite_id: inviteId, tenant_id: tenantId, role: 'adult' },
      });
      await db
        .update(pendingInvitations)
        .set({ supabaseInviteId: supabaseUser.id, updatedAt: new Date() })
        .where(eq(pendingInvitations.id, inviteId));
      invitesSent += 1;
    } catch (err) {
      if (inviteId) {
        await db
          .update(pendingInvitations)
          .set({ status: 'expired', updatedAt: new Date() })
          .where(eq(pendingInvitations.id, inviteId))
          .catch(() => undefined);
      }
      log.error(
        { err: err instanceof Error ? err.message : String(err), tenantId, email: target.email },
        'onboarding invite failed (family still created)',
      );
    }
  }

  log.info(
    {
      tenantId,
      membersAdded,
      invitesSent,
      seedHabitsAdded,
      seedRewardsAdded,
      timezone: parsed.data.timezone,
      currency: parsed.data.currency,
    },
    'onboarding completed',
  );

  return c.json(
    completeOnboardingResponseSchema.parse(project(updatedTenant, membersAdded, invitesSent)),
    200,
  );
});
