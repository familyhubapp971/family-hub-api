import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { members } from '../db/schema.js';

// FHS-341: one home for the family permission checks that every route used to
// re-declare. Behaviour is unchanged from those copies; this just removes the
// duplication so the admin/normal boundary lives in a single place.
//
// Two tiers of access (see ADR 0015):
//   • canManage: everyday access. The caller IS the member, or a parent
//     (admin/adult). Used for reads + current-day writes.
//   • isAdmin: sensitive / historical / irreversible actions only
//     (edit a past day, close/reopen a week, change the economy,
//     manage members/habits). FHS-335 / FHS-342.

type Db = ReturnType<typeof getDb>;

export interface Caller {
  id: string;
  role: string;
}

/** The caller's membership row (id + role) in a tenant, or null if not a member. */
export async function loadCaller(db: Db, tenantId: string, userId: string): Promise<Caller | null> {
  const rows = await db
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Everyday access: the caller IS the member, or a parent (admin/adult). */
export function canManage(caller: Caller, memberId: string): boolean {
  return caller.id === memberId || caller.role === 'admin' || caller.role === 'adult';
}

/** Sensitive / historical / irreversible actions are admin-only. */
export function isAdmin(caller: { role: string }): boolean {
  return caller.role === 'admin';
}

/** Admin or a non-admin adult (the legacy "parent" tier). */
export function isAdminOrAdult(caller: { role: string }): boolean {
  return caller.role === 'admin' || caller.role === 'adult';
}

/** True if `memberId` is a member of this tenant. */
export async function memberInTenant(db: Db, tenantId: string, memberId: string): Promise<boolean> {
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.id, memberId)))
    .limit(1);
  return rows.length > 0;
}
