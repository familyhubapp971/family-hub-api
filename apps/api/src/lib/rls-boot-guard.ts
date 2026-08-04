import { sql } from 'drizzle-orm';
import { getRootDb } from '../db/client.js';

// FHS-351: boot interlock for the app_runtime flip.
//
// When RLS_ENFORCED is on, the app must be connected as the non-privileged
// app_runtime role so Postgres actually polices it. If DATABASE_URL is ever
// (mis)configured back to the owner/superuser (which BYPASSES RLS), every
// request would silently serve cross-tenant data with the lock disabled. This
// guard reads the connected role's attributes at boot and refuses to start in
// that case, turning a silent security failure into a loud, obvious one.

// `type` (not `interface`) so it satisfies drizzle's `execute<T extends
// Record<string, unknown>>` constraint: interfaces lack the implicit index sig.
export type ConnectedRole = {
  rolname: string;
  rolbypassrls: boolean;
  rolsuper: boolean;
};

/** Reads the role the current connection authenticates as. */
export async function readConnectedRole(): Promise<ConnectedRole> {
  const { rows } = await getRootDb().execute<ConnectedRole>(
    sql`select rolname, rolbypassrls, rolsuper from pg_roles where rolname = current_user`,
  );
  const row = rows[0];
  if (!row) {
    throw new Error('RLS boot guard: could not read the connected role from pg_roles');
  }
  return row;
}

/**
 * Throws if the connected role can bypass RLS (BYPASSRLS or superuser). Call at
 * boot only when RLS enforcement is expected (config.RLS_ENFORCED).
 */
export async function assertRlsEnforceable(): Promise<void> {
  const role = await readConnectedRole();
  if (role.rolbypassrls || role.rolsuper) {
    throw new Error(
      `RLS boot guard: connected role "${role.rolname}" can bypass RLS ` +
        `(bypassrls=${role.rolbypassrls}, superuser=${role.rolsuper}). Refusing to start with ` +
        `RLS_ENFORCED=true: point DATABASE_URL at the non-privileged app_runtime role.`,
    );
  }
}
