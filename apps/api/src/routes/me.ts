import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { members, tenants } from '../db/schema.js';
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

  // Pull the user's tenants via members → tenants join. One round-trip,
  // returns the slugs + onboarding flag the wizard needs for its gate.
  const db = getDb();
  const tenantRows = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      onboardingCompleted: tenants.onboardingCompleted,
      role: members.role,
    })
    .from(members)
    .innerJoin(tenants, eq(members.tenantId, tenants.id))
    .where(eq(members.userId, row.id));

  const response: MeResponse = {
    id: row.id,
    email: row.email,
    createdAt: row.createdAt.toISOString(),
    tenants: tenantRows.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      role: t.role,
      onboardingCompleted: t.onboardingCompleted,
    })),
  };
  return c.json(meResponseSchema.parse(response));
});
