import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { members, tenants } from '../db/schema.js';

// FHS-238 — GET /api/public/kid-members/:slug
//
// Reads the avatar grid the kid sees on the family iPad's /t/:slug/kid-login
// page. Returns the family display name + every kid member that has a
// PIN set, ordered by display name so the layout is stable across
// requests.
//
// Auth NOT required — this is the data a kid would see by walking up
// to the device. The slug is the access boundary; anyone who knows
// the family's slug already has the same level of access. We
// deliberately expose only display name + emoji + id — never email,
// role, or PIN data. The kid-PIN endpoint (FHS-236) does the
// constant-time check on submission, so listing the IDs here doesn't
// leak anything an attacker couldn't already brute-force one slug at
// a time.
//
// Open to abuse via slug-enumeration scraping; tracked under FHS-205
// for rate-limiting if it materialises in practice.

const paramsSchema = z.object({
  slug: z
    .string()
    .min(2, 'slug must be at least 2 characters')
    .max(63, 'slug must be at most 63 characters')
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'invalid tenant slug'),
});

export const publicKidMembersResponseSchema = z.object({
  family: z.object({
    slug: z.string(),
    name: z.string(),
  }),
  kids: z.array(
    z.object({
      id: z.string().uuid(),
      displayName: z.string(),
      avatarEmoji: z.string().nullable(),
    }),
  ),
});

export type PublicKidMembersResponse = z.infer<typeof publicKidMembersResponseSchema>;

export const publicKidMembersRouter = new Hono().get('/:slug', async (c) => {
  // Lowercase the slug before validating — iOS auto-capitalises the
  // first character of pasted URLs in some apps (Notes, Mail), and a
  // kid following a "/t/Khan/kid-login" link should land on Khan's
  // family page, not a 404.
  const rawSlug = c.req.param('slug') ?? '';
  const parsed = paramsSchema.safeParse({ slug: rawSlug.toLowerCase() });
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid request',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    );
  }

  const db = getDb();
  const [tenantRow] = await db
    .select({ id: tenants.id, slug: tenants.slug, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.slug, parsed.data.slug))
    .limit(1);

  if (!tenantRow) {
    return c.json({ error: 'family not found', errorCode: 'TENANT_NOT_FOUND' }, 404);
  }

  // Only kids with a PIN set are shown. A kid added by an adult who
  // hasn't set their PIN yet shouldn't appear on the avatar grid —
  // tapping their face would always 401 and read as broken.
  const kids = await db
    .select({
      id: members.id,
      displayName: members.displayName,
      avatarEmoji: members.avatarEmoji,
    })
    .from(members)
    .where(
      and(
        eq(members.tenantId, tenantRow.id),
        eq(members.isChild, true),
        isNotNull(members.pinHash),
      ),
    )
    .orderBy(asc(members.displayName));

  const response: PublicKidMembersResponse = {
    family: { slug: tenantRow.slug, name: tenantRow.name },
    kids,
  };
  return c.json(publicKidMembersResponseSchema.parse(response));
});
