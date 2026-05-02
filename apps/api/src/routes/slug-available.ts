import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { tenants } from '../db/schema.js';

// FHS-27 — GET /api/public/slug-available?slug=khan
//
// Lightweight read used by the live slug debounce on /signup
// (FHS-225). Returns whether the slug is free + a couple of suggestions
// when it isn't. Auth NOT required — slug availability is a yes/no
// fact about the public DNS-style namespace; leaking which slugs are
// taken is no worse than letting people try to register them.
//
// Mounted under /api/public/slug-available so it sits next to
// /api/public/tenant in the same auth-optional namespace.

const queryParamsSchema = z.object({
  slug: z
    .string()
    .min(2, 'slug must be at least 2 characters')
    .max(30, 'slug must be at most 30 characters')
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'slug must be lowercase, digits, hyphens'),
});

export const slugAvailableResponseSchema = z.object({
  slug: z.string(),
  available: z.boolean(),
  /**
   * When `available=false`, three suggestions: the slug with a numeric
   * suffix and two with descriptive suffixes ("-family", "-home").
   * Empty when available.
   */
  suggestions: z.array(z.string()),
});

export type SlugAvailableResponse = z.infer<typeof slugAvailableResponseSchema>;

function suggest(taken: string): string[] {
  // Two-digit numeric ('khan' → 'khan42'), and two descriptive
  // alternatives. Capped at the 30-char schema limit so the
  // suggestion is always insertable.
  const suffixes = ['42', '-family', '-home'];
  return suffixes.map((s) => `${taken}${s}`.slice(0, 30));
}

export const slugAvailableRouter = new Hono().get('/', async (c) => {
  const parsed = queryParamsSchema.safeParse({ slug: c.req.query('slug') });
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid slug',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
      400,
    );
  }

  const db = getDb();
  const existing = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, parsed.data.slug))
    .limit(1);

  const available = existing.length === 0;
  const response: SlugAvailableResponse = {
    slug: parsed.data.slug,
    available,
    suggestions: available ? [] : suggest(parsed.data.slug),
  };
  return c.json(slugAvailableResponseSchema.parse(response));
});
