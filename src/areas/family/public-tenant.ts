import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../database/client.js';
import { tenants, members, type Tenant, type Member } from '../../database/schema.js';
import { getAuthenticatedUser } from '../../security/auth.js';
import { generateFamilyCode } from './family-code.js';
import { createLogger } from '../../services/logger.js';

// FHS-25: POST /api/public/tenant.
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
// "public" in the path is a misnomer: it's the public *namespace* (no
// tenant context required), but auth IS required because we need a
// user id to attach to the membership row.

const log = createLogger('public-tenant');

// FHS-715: the address is made by the server (a private code, e.g. e29b-41d4),
// so people never have to invent one. An address sent by an older website or
// app is accepted and ignored.
export const createTenantRequestSchema = z.object({
  // FHS-714: at least one character, so a family called 李 or a one-letter
  // name is welcome (every kind of family).
  familyName: z.string().trim().min(1, 'family name is required').max(80),
  displayName: z.string().trim().min(1, 'display name is required').max(80),
  slug: z.string().optional(),
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

/** The family this person created (FHS-716), with their admin seat in it. */
async function findOwnFamily(
  db: ReturnType<typeof getDb>,
  userId: string,
): Promise<{ tenant: Tenant; member: Member } | null> {
  const rows = await db.select().from(tenants).where(eq(tenants.createdBy, userId)).limit(1);
  const tenant = rows[0];
  if (!tenant) return null;
  const member = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_tenant', ${tenant.id}, true)`);
    const seats = await tx
      .select()
      .from(members)
      .where(and(eq(members.tenantId, tenant.id), eq(members.userId, userId)))
      .limit(1);
    return seats[0];
  });
  return member ? { tenant, member } : null;
}

export const publicTenantRouter = new Hono().post('/', async (c) => {
  // getAuthenticatedUser asserts the request was through authMiddleware.
  // userRow is the public.users mirror: guaranteed non-null in
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

  // FHS-716: one family per home. Someone who already created a family gets
  // it back instead of a second one. That also makes a retry after a lost
  // reply (weak signal, a slow server) safe: it answers with the same family.
  const own = await findOwnFamily(db, userRow.id);
  if (own) {
    log.info(
      { tenantId: own.tenant.id, userId: userRow.id },
      'family already created: returning it',
    );
    return c.json(createTenantResponseSchema.parse(project(own.tenant, own.member)), 200);
  }

  let tenant: Tenant | undefined;
  let member: Member | undefined;
  // A clash between two random codes is about one in 4 billion; try again.
  for (let attempt = 0; attempt < 5 && !tenant; attempt += 1) {
    const code = generateFamilyCode();
    try {
      // FHS-351: create the tenant + its founding member atomically, with the
      // new tenant pinned so the members RLS WITH CHECK passes. On signup there is
      // no resolved tenant yet (app.current_tenant is the empty sentinel), so
      // once the app runs as app_runtime the founding members INSERT would be
      // rejected without this pin. set_config(..., true) is transaction-local and
      // auto-clears on commit.
      const created = await db.transaction(async (tx) => {
        const insertedTenants = await tx
          .insert(tenants)
          .values({ slug: code, name: parsed.data.familyName, createdBy: userRow.id })
          .returning();
        const t = insertedTenants[0];
        if (!t) throw new Error('tenants insert returned no row');
        await tx.execute(sql`select set_config('app.current_tenant', ${t.id}, true)`);
        // The founder always lands as `admin`: they created the family and
        // only an admin can complete onboarding (onboarding.ts).
        const insertedMembers = await tx
          .insert(members)
          .values({
            tenantId: t.id,
            userId: userRow.id,
            displayName: parsed.data.displayName,
            role: 'admin',
          })
          .returning();
        const m = insertedMembers[0];
        if (!m) throw new Error('members insert returned no row');
        return { tenant: t, member: m };
      });
      tenant = created.tenant;
      member = created.member;
    } catch (err) {
      // Postgres error code 23505 = unique_violation: the code was taken.
      const isUniqueViolation =
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: string }).code === '23505';
      if (isUniqueViolation) continue;
      log.error({ err, userId: userRow.id }, 'public-tenant insert failed');
      throw err;
    }
  }
  if (!tenant || !member) throw new Error('could not make a unique family code');

  log.info({ tenantId: tenant.id, slug: tenant.slug, userId: userRow.id }, 'tenant created');

  const response = project(tenant, member);
  return c.json(createTenantResponseSchema.parse(response), 201);
});
