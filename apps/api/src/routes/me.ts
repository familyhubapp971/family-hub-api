import { Hono } from 'hono';
import { z } from 'zod';
import { getAuthenticatedUser } from '../middleware/auth.js';

// FHS-194 — Protected GET /api/me.
//
// Auth middleware runs upstream and (a) verifies the Supabase JWT,
// (b) upserts the users-mirror row, (c) attaches both the verified
// claims (`user`) and the DB row (`userRow`) to context. This handler
// just reads the mirror row and projects the public shape.
//
// Returning the mirror row (not the JWT claims) is deliberate: the
// mirror is the ID app tables foreign-key against, so /api/me's contract
// matches what every other endpoint will see.

export const meResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  createdAt: z.string().datetime(),
});

export type MeResponse = z.infer<typeof meResponseSchema>;

export const meRouter = new Hono().get('/', (c) => {
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

  const response: MeResponse = {
    id: row.id,
    email: row.email,
    createdAt: row.createdAt.toISOString(),
  };
  return c.json(meResponseSchema.parse(response));
});
