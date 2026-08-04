import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { users, type User } from '../db/schema.js';
import { config } from '../config.js';

// FHS-465: the mirror upsert ran as a write TRANSACTION on EVERY authenticated
// request (a real UPDATE every time: `updated_at = now()` always changes the
// row, so WAL + row-version churn + a connection checkout on 100% of traffic).
// Once we've confirmed a given (id, email) pair is mirrored, that fact can't
// become false during normal operation, so cache it per-replica and skip the DB
// entirely on the warm path. Keyed by id+email, so a Supabase-side email change
// is a cache miss → the upsert runs and refreshes the row. A short TTL bounds
// both memory and staleness (e.g. an out-of-band user delete).
//
// Disabled under NODE_ENV=test: the integration tier TRUNCATEs between scenarios
// and the module-level cache would otherwise survive the reset and hand back a
// row for a user the (now-empty) DB no longer has. Tests set USER_MIRROR_CACHE
// to exercise the cache path in isolation.
const MIRROR_TTL_MS = 5 * 60_000;
const mirrorCache = new Map<string, { row: User; expires: number }>();

function cacheEnabled(): boolean {
  return config.NODE_ENV !== 'test' || process.env['USER_MIRROR_CACHE'] === 'on';
}

/** Test hook: clear the per-replica mirror cache between cases. */
export function resetUserMirrorCache(): void {
  mirrorCache.clear();
}

// Users mirror sync (FHS-192).
//
// Supabase owns `auth.users`; our app needs a row in `public.users` so
// app tables can FK to a stable user id. On the first authenticated
// request, we INSERT a mirror row from the verified JWT claims; on
// subsequent requests the row already exists.
//
// This module is intentionally _not_ wired into the auth middleware in
// FHS-192: that wiring is deferred to a follow-up commit on this
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
  /** JWT `sub` claim: the Supabase auth user id. UUID string. */
  id: string;
  /** JWT `email` claim: required for the mirror row. */
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
  // FHS-465: warm path: a confirmed (id, email) pair skips the DB entirely.
  const cacheKey = `${claims.id}:${claims.email}`;
  const useCache = cacheEnabled();
  if (useCache) {
    const hit = mirrorCache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.row;
  }

  // FHS-349: `users` carries self-scoped RLS keyed on app.current_user. This
  // mirror runs as app_runtime BEFORE the request-scoped tenant context exists,
  // so it pins the caller's own id transaction-locally (set_config is_local=true)
  // so the self-isolation policy permits this upsert + RETURNING. Transaction-
  // local auto-clears on commit: leak-free even on the shared root pool. The
  // value is parameterized; app_current_user() also fail-closes on bad input.
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_user', ${claims.id}, true)`);
    const [upserted] = await tx
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

    if (!upserted) {
      // Unreachable: ON CONFLICT DO UPDATE always RETURNINGs a row.
      // Throwing keeps a future regression loud rather than silent.
      throw new Error(`getOrCreateUser: upsert returned no row for id=${claims.id}`);
    }
    return upserted;
  });

  if (useCache) mirrorCache.set(cacheKey, { row, expires: Date.now() + MIRROR_TTL_MS });
  return row;
}
