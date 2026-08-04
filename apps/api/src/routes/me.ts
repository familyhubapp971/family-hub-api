import { Hono } from 'hono';
import { z } from 'zod';
import { sql, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { members, tenants } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { createLogger } from '../logger.js';

const log = createLogger('me');

// `type` (not `interface`) so it satisfies drizzle's execute<T extends
// Record<string, unknown>> constraint: interfaces lack the implicit index sig.
type MeTenantRow = {
  tenant_id: string;
  slug: string;
  name: string;
  onboarding_completed: boolean;
  role: string;
};

// FHS-194: Protected GET /api/me.
//
// Auth middleware runs upstream and (a) verifies the Supabase JWT,
// (b) upserts the users-mirror row, (c) attaches both the verified
// claims (`user`) and the DB row (`userRow`) to context. This handler
// reads the mirror row plus the user's tenant memberships and projects
// the public shape.
//
// Tenants array (FHS-37): the OnboardingWizard mount uses this to
// decide whether to redirect into /dashboard (onboarding already done)
// or render the wizard. One join, no per-tenant round-trip needed.

export const meTenantSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  role: z.string(),
  onboardingCompleted: z.boolean(),
});

export const meResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  createdAt: z.string().datetime(),
  tenants: z.array(meTenantSchema),
});

export type MeResponse = z.infer<typeof meResponseSchema>;

export const meRouter = new Hono().get('/', async (c) => {
  // getAuthenticatedUser asserts the request passed authMiddleware:
  // throws loudly during dev if someone forgets to mount auth.
  getAuthenticatedUser(c);

  const row = c.get('userRow');
  if (!row) {
    // Unreachable when auth middleware ran successfully (it sets userRow
    // in the same step as user). Throw rather than 500 silently: the
    // onError handler captures + logs + Sentry-reports.
    throw new Error('me handler reached without userRow on context');
  }

  // Pull the user's tenants across families. This is a deliberately
  // cross-tenant read (a user can belong to several families), so it goes
  // through the SECURITY DEFINER function app_user_memberships (FHS-354) rather
  // than a direct members→tenants join: under RLS (app_runtime) a direct join
  // would return zero rows because there's no single tenant context here.
  const db = getDb();
  let tenantRows: MeTenantRow[];
  try {
    tenantRows = (
      await db.execute<MeTenantRow>(sql`select tenant_id, slug, name, onboarding_completed, role
         from app_user_memberships(${row.id})`)
    ).rows;
  } catch (err) {
    // FHS-357: the function is created on boot (apply-functions.mjs), not by
    // drizzle-kit push. If a deploy hasn't created it yet, never strand a user
    // with a family on the onboarding screen: fall back to the direct join.
    // Pre-flip the app runs as the owner so this works; post-flip the function
    // is guaranteed present, so this branch won't run.
    log.warn(
      { err: err instanceof Error ? err.message : String(err), userId: row.id },
      'app_user_memberships unavailable: falling back to direct members→tenants join',
    );
    const rows = await db
      .select({
        tenant_id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        onboarding_completed: tenants.onboardingCompleted,
        role: members.role,
      })
      .from(members)
      .innerJoin(tenants, eq(members.tenantId, tenants.id))
      .where(eq(members.userId, row.id));
    tenantRows = rows;
  }

  const response: MeResponse = {
    id: row.id,
    email: row.email,
    createdAt: row.createdAt.toISOString(),
    tenants: tenantRows.map((t) => ({
      id: t.tenant_id,
      slug: t.slug,
      name: t.name,
      role: t.role,
      onboardingCompleted: t.onboarding_completed,
    })),
  };
  return c.json(meResponseSchema.parse(response));
});
