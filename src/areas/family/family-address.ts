import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../database/client.js';
import { members, tenants } from '../../database/schema.js';
import { getAuthenticatedUser } from '../../security/auth.js';
import { loadCaller } from '../../security/permissions.js';

// FHS-715: GET /api/family-address/:oldSlug
//
// Families moved from a surname address (/t/smith) to a private code
// (/t/e29b-41d4). An old link still works for the family's own signed-in
// members: this answers with the new address so the website can forward them.
// Anyone else gets 404, so an old surname never reveals a family or its kids.

export const familyAddressResponseSchema = z.object({
  slug: z.string(),
  name: z.string(),
});

// FHS-715: GET /api/family-address (the family the request is about).
// Its code, and the old surname address it replaced if any, for its own
// members. The Members page shows a one-time note to families who moved:
// kid tablets set up with the surname ask once for the new code.
export const currentFamilyAddressResponseSchema = z.object({
  slug: z.string(),
  previousSlug: z.string().nullable(),
});

const paramsSchema = z.object({
  oldSlug: z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .pipe(z.string().min(2).max(63)),
});

export const familyAddressRouter = new Hono()
  .get('/', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    const tenantId = c.get('tenantId');
    if (!userRow || !tenantId) return c.json({ error: 'tenant context required' }, 400);
    const db = getDb();
    const caller = await loadCaller(db, tenantId, userRow.id);
    if (!caller) return c.json({ error: 'not a member of this family' }, 403);
    const rows = await db
      .select({ slug: tenants.slug, previousSlug: tenants.previousSlug })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const family = rows[0];
    if (!family) return c.json({ error: 'not found' }, 404);
    return c.json(currentFamilyAddressResponseSchema.parse(family), 200);
  })
  .get('/:oldSlug', async (c) => {
    getAuthenticatedUser(c);
    const userRow = c.get('userRow');
    if (!userRow) throw new Error('family-address handler reached without userRow');
    const parsed = paramsSchema.safeParse(c.req.param());
    if (!parsed.success) return c.json({ error: 'not found' }, 404);

    const db = getDb();
    const rows = await db
      .select()
      .from(tenants)
      .where(eq(tenants.previousSlug, parsed.data.oldSlug))
      .limit(1);
    const tenant = rows[0];
    if (!tenant) return c.json({ error: 'not found' }, 404);

    // Only the family's own members learn the new address.
    const seat = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_tenant', ${tenant.id}, true)`);
      const seats = await tx
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.tenantId, tenant.id), eq(members.userId, userRow.id)))
        .limit(1);
      return seats[0];
    });
    if (!seat) return c.json({ error: 'not found' }, 404);

    return c.json(familyAddressResponseSchema.parse({ slug: tenant.slug, name: tenant.name }), 200);
  });
