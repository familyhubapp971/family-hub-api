import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { members, memberRole, tenants, type Tenant } from '../db/schema.js';
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
//     each with name + role + optional emoji)
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

const wizardMemberSchema = z.object({
  displayName: z.string().min(1).max(80),
  role: wizardMemberRoleSchema,
  avatarEmoji: z.string().min(1).max(8).optional(),
});

export const completeOnboardingRequestSchema = z.object({
  timezone: timezoneSchema,
  currency: currencySchema,
  members: z.array(wizardMemberSchema).min(1).max(8),
});

export const completeOnboardingResponseSchema = z.object({
  tenant: z.object({
    id: z.string().uuid(),
    timezone: z.string(),
    currency: z.string(),
    onboardingCompleted: z.literal(true),
  }),
  membersAdded: z.number().int().nonnegative(),
});

export type CompleteOnboardingResponse = z.infer<typeof completeOnboardingResponseSchema>;

function project(tenant: Tenant, membersAdded: number): CompleteOnboardingResponse {
  return {
    tenant: {
      id: tenant.id,
      timezone: tenant.timezone,
      currency: tenant.currency,
      onboardingCompleted: true,
    },
    membersAdded,
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
    return c.json(completeOnboardingResponseSchema.parse(project(current, 0)), 200);
  }

  // Single transaction: members insert + tenant update + starter
  // content seed (FHS-40) all commit together. Partial failure rolls
  // back the whole onboarding so the family doesn't end up in a
  // half-onboarded state.
  let updatedTenant: Tenant | undefined;
  let membersAdded = 0;
  let seedHabitsAdded = 0;
  let seedRewardsAdded = 0;
  try {
    await db.transaction(async (tx) => {
      const newMemberRows = parsed.data.members.map((m) => ({
        tenantId,
        displayName: m.displayName,
        role: m.role,
        avatarEmoji: m.avatarEmoji ?? null,
      }));
      const inserted = await tx.insert(members).values(newMemberRows).returning({ id: members.id });
      membersAdded = inserted.length;

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

  log.info(
    {
      tenantId,
      membersAdded,
      seedHabitsAdded,
      seedRewardsAdded,
      timezone: parsed.data.timezone,
      currency: parsed.data.currency,
    },
    'onboarding completed',
  );

  return c.json(completeOnboardingResponseSchema.parse(project(updatedTenant, membersAdded)), 200);
});
