import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { tenants, members, type Tenant, type Member } from '../db/schema.js';
import { getAuthenticatedUser } from '../middleware/auth.js';
import { createLogger } from '../logger.js';

// FHS-25 — POST /api/public/tenant.
//
// Called by the web app immediately after the magic-link callback
// completes. The user is already authenticated (Supabase magic link
// minted the session); this endpoint creates:
//   1. a `tenants` row (the family) with the chosen slug + name, and
//   2. a `members` row linking the authenticated user to the new
//      tenant as the founding adult member.
//
// Returns the created tenant + member so the web client can navigate
// straight to /onboarding without an extra round-trip.
//
// "public" in the path is a misnomer — it's the public *namespace* (no
// tenant context required), but auth IS required because we need a
// user id to attach to the membership row.

const log = createLogger('public-tenant');

// Slug rules (mirror SignupPage.deriveSlug):
//   - 2..30 chars
//   - lowercase letters, digits, hyphens
//   - cannot start/end with a hyphen
const slugSchema = z
  .string()
  .min(2, 'slug must be at least 2 characters')
  .max(30, 'slug must be at most 30 characters')
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'slug must be lowercase, digits, hyphens');

export const createTenantRequestSchema = z.object({
  familyName: z.string().min(2, 'family name is required').max(80),
  displayName: z.string().min(2, 'display name is required').max(80),
  slug: slugSchema,
});

export const createTenantResponseSchema = z.object({
  tenant: z.object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    createdAt: z.string().datetime(),
  }),
  member: z.object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    displayName: z.string(),
    role: z.string(),
  }),
});

export type CreateTenantResponse = z.infer<typeof createTenantResponseSchema>;

function project(tenant: Tenant, member: Member): CreateTenantResponse {
  return {
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      createdAt: tenant.createdAt.toISOString(),
    },
    member: {
      id: member.id,
      tenantId: member.tenantId,
      displayName: member.displayName,
      role: member.role,
    },
  };
}

export const publicTenantRouter = new Hono().post('/', async (c) => {
  // getAuthenticatedUser asserts the request was through authMiddleware.
  // userRow is the public.users mirror — guaranteed non-null in
  // production wiring (the auth middleware upserts it on first hit).
  getAuthenticatedUser(c);
  const userRow = c.get('userRow');
  if (!userRow) {
    throw new Error('public-tenant handler reached without userRow on context');
  }

  const body = await c.req.json().catch(() => null);
  const parsed = createTenantRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid request',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
      400,
    );
  }

  const db = getDb();

  // Slug uniqueness: cheap pre-check + handle the race at insert-time.
  // The unique index on tenants.slug (FHS-2) is the source of truth —
  // the pre-check just lets us return a clean 409 with a useful body
  // when there's no race in flight.
  const existing = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, parsed.data.slug))
    .limit(1);
  if (existing.length > 0) {
    return c.json({ error: 'slug taken', field: 'slug', slug: parsed.data.slug }, 409);
  }

  let tenant: Tenant;
  let member: Member;
  try {
    const insertedTenants = await db
      .insert(tenants)
      .values({ slug: parsed.data.slug, name: parsed.data.familyName })
      .returning();
    const t = insertedTenants[0];
    if (!t) throw new Error('tenants insert returned no row');
    tenant = t;

    const insertedMembers = await db
      .insert(members)
      .values({
        tenantId: tenant.id,
        userId: userRow.id,
        displayName: parsed.data.displayName,
        role: 'adult',
      })
      .returning();
    const m = insertedMembers[0];
    if (!m) throw new Error('members insert returned no row');
    member = m;
  } catch (err) {
    // Postgres error code 23505 = unique_violation. Lost a slug race.
    const isUniqueViolation =
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === '23505';
    if (isUniqueViolation) {
      return c.json({ error: 'slug taken', field: 'slug', slug: parsed.data.slug }, 409);
    }
    log.error({ err, userId: userRow.id }, 'public-tenant insert failed');
    throw err;
  }

  log.info({ tenantId: tenant.id, slug: tenant.slug, userId: userRow.id }, 'tenant created');

  const response = project(tenant, member);
  return c.json(createTenantResponseSchema.parse(response), 201);
});
