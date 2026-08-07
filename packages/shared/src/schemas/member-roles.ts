// Member roles, and the one rule for "is this member a kid?" (FHS-569).
//
// The role enum lives in the database (apps/api/src/db/schema.ts, member_role)
// and is mirrored here so both the API and the web app can reason about it
// without importing each other.
//
// Why this file exists: the kid predicate was hand-rolled in at least six
// places, and one of them (the dashboard profile menu) checked only 'child'.
// A family whose only kid was a teen was told "No kids added yet" while the
// same teen showed on the dashboard two inches away. One helper, used
// everywhere, is how that stops happening.

export const MEMBER_ROLES = ['admin', 'adult', 'teen', 'child', 'guest'] as const;

export type MemberRole = (typeof MEMBER_ROLES)[number];

/**
 * Roles that represent a child in the family: someone with their own world,
 * a PIN sign-in and habits, rather than an adult who administers the hub.
 */
export const KID_ROLES: ReadonlySet<string> = new Set<MemberRole>(['child', 'teen']);

/**
 * True when the member is a kid (child or teen).
 *
 * Takes a plain string so callers holding a loosely-typed role from an API
 * response do not have to cast. Anything unrecognised is not a kid.
 */
export function isKidRole(role: string | null | undefined): boolean {
  return role !== null && role !== undefined && KID_ROLES.has(role);
}

/**
 * Roles that can sign in with a 4-digit PIN rather than an email link.
 * Currently the same set as the kids, but kept separate because the two
 * answer different questions: one is "who is a child", the other is
 * "how does this member get in".
 */
export const PIN_ELIGIBLE_ROLES: ReadonlySet<string> = new Set<MemberRole>(['child', 'teen']);

export function isPinEligibleRole(role: string | null | undefined): boolean {
  return role !== null && role !== undefined && PIN_ELIGIBLE_ROLES.has(role);
}

// FHS-625: who is allowed to do what with a child's money and the family's
// settings. The dividing line is whether the action can be undone.
//
// These mirror `apps/api/src/lib/permissions.ts` (canManage / isAdmin, ADR
// 0015), which is what actually enforces the rule. Nothing here is a gate:
// the server refuses regardless of what the browser decided to render. They
// exist so the app can stop offering a door that leads to a locked room, and
// so the rule is written down once instead of retyped per page.
//
// The pairing is pinned by tests/unit/shared/family-permissions.test.ts, which
// walks every role against both the API's guards and these predicates.

/**
 * Grown-ups: the everyday money moves that can be reversed. Handing a child
 * their pocket money, banking it, investing it, taking it back out.
 *
 * Matches the API's `canManage` for a caller acting on someone else. A member
 * acting on their own money passes on the API side too (canManage's self
 * branch), which is why a child can still see and spend their own balance.
 */
export function isGrownUpRole(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'adult';
}

/**
 * Admins only: the things that cannot be undone, or that change the whole
 * family. Closing, reopening or repairing a week; setting a balance by hand;
 * what a sticker is worth; the family's name, currency, data export and
 * deletion.
 *
 * Matches the API's `isAdmin`.
 */
export function isFamilyAdminRole(role: string | null | undefined): boolean {
  return role === 'admin';
}
