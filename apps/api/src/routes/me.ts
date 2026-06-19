import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { getAuthenticatedUser } from '../middleware/auth.js';

// FHS-194 — Protected GET /api/me.
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
  // getAuthenticatedUser asserts the request passed authMiddleware —
  // throws loudly during dev if someone forgets to mount auth.
  getAuthenticatedUser(c);

  const row = c.get('userRow');
  if (!row) {
    // Unreachable when auth middleware ran successfully (it sets userRow
    // in the same step as user). Throw rather than 500 silently — the
    // onError handler captures + logs + Sentry-reports.
    throw new Error('me handler reached without userRow on context');
  }

  // Pull the user's tenants across families. This is a deliberately
  // cross-tenant read (a user can belong to several families), so it goes
  // through the SECURITY DEFINER function app_user_memberships (FHS-354) rather
  // than a direct members→tenants join — under RLS (app_runtime) a direct join
  // would return zero rows because there's no single tenant context here.
  const db = getDb();
  const { rows: tenantRows } = await db.execute<{
    tenant_id: string;
    slug: string;
    name: string;
    onboarding_completed: boolean;
    role: string;
  }>(sql`select tenant_id, slug, name, onboarding_completed, role
         from app_user_memberships(${row.id})`);

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
