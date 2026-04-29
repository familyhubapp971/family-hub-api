import type { Database } from '../db/client.js';
import { users, type User } from '../db/schema.js';

// Users mirror sync (FHS-192).
//
// Supabase owns `auth.users`; our app needs a row in `public.users` so
// app tables can FK to a stable user id. On the first authenticated
// request, we INSERT a mirror row from the verified JWT claims; on
// subsequent requests the row already exists.
//
// This module is intentionally _not_ wired into the auth middleware in
// FHS-192 — that wiring is deferred to a follow-up commit on this
// branch (or a small follow-on PR) once FHS-191's middleware lands on
// staging. The integration point is one line inside `authMiddleware`,
// after token verification and before tenant resolution:
//
//   await getOrCreateUser(getDb(), { id: sub, email });
//
// Concurrency safety comes from the `id` PRIMARY KEY constraint plus
// `ON CONFLICT (id) DO UPDATE ... RETURNING *`: two simultaneous
// first-requests for the same user resolve to a single row, and both
// callers get the row back in one round-trip.

export interface UserMirrorClaims {
  /** JWT `sub` claim — the Supabase auth user id. UUID string. */
  id: string;
  /** JWT `email` claim — required for the mirror row. */
  email: string;
}

/**
 * Idempotent upsert of a `public.users` row from verified JWT claims.
 *
 * Always returns the row that exists in the database after the call.
 * Safe to invoke on every authenticated request; the warm path is a
 * single SQL statement (INSERT ... ON CONFLICT DO UPDATE RETURNING).
 *
 * On conflict the email is refreshed from the JWT (so a Supabase-side
 * email change propagates on the next request) and `updated_at` is
 * bumped. We accept the per-request write cost as the price of a
 * statelessly-correct mirror; a `setWhere` skip would save IO at the
 * cost of a "no row returned, must SELECT" branch that's painful to
 * test deterministically.
 */
export async function getOrCreateUser(db: Database, claims: UserMirrorClaims): Promise<User> {
  const [row] = await db
    .insert(users)
    .values({
      id: claims.id,
      email: claims.email,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        email: claims.email,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!row) {
    // Unreachable: ON CONFLICT DO UPDATE always RETURNINGs a row.
    // Throwing keeps a future regression loud rather than silent.
    throw new Error(`getOrCreateUser: upsert returned no row for id=${claims.id}`);
  }
  return row;
}
