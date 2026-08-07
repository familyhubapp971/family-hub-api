import { describe, it, expect } from 'vitest';
import { MEMBER_ROLES, isGrownUpRole, isFamilyAdminRole } from '@familyhub/shared';
import { canManage, isAdmin } from '../../../apps/api/src/lib/permissions.js';

// FHS-625: the app now decides which money and settings doors to show from
// these two predicates. If they ever drift from what the API actually
// enforces, the app starts offering doors that lead to a 403, or hiding ones
// it should not: the exact bug this ticket exists to fix.
//
// So this walks every role in the enum against BOTH sides. The API's
// permissions module is imported directly, not re-described, so a change to
// the real guard fails here rather than shipping a lying menu.

const CALLER_ID = 'caller-member-id';
const OTHER_ID = 'someone-elses-member-id';

describe('family permissions: the shared predicates match the API guards', () => {
  it.each(MEMBER_ROLES)("'%s': isGrownUpRole matches canManage against another member", (role) => {
    // canManage has a self branch (you may always manage your own money), so
    // the role-only question is what it answers about SOMEONE ELSE.
    expect(isGrownUpRole(role)).toBe(canManage({ id: CALLER_ID, role }, OTHER_ID));
  });

  it.each(MEMBER_ROLES)("'%s': isFamilyAdminRole matches isAdmin", (role) => {
    expect(isFamilyAdminRole(role)).toBe(isAdmin({ role }));
  });

  it('every member may act on their own money, whatever their role', () => {
    for (const role of MEMBER_ROLES) {
      expect(canManage({ id: CALLER_ID, role }, CALLER_ID)).toBe(true);
    }
  });
});

describe('family permissions: the answers themselves', () => {
  it('admins and adults are grown-ups; kids and guests are not', () => {
    expect(isGrownUpRole('admin')).toBe(true);
    expect(isGrownUpRole('adult')).toBe(true);
    expect(isGrownUpRole('teen')).toBe(false);
    expect(isGrownUpRole('child')).toBe(false);
    expect(isGrownUpRole('guest')).toBe(false);
  });

  it('only an admin is the family admin', () => {
    expect(isFamilyAdminRole('admin')).toBe(true);
    expect(isFamilyAdminRole('adult')).toBe(false);
    expect(isFamilyAdminRole('teen')).toBe(false);
    expect(isFamilyAdminRole('child')).toBe(false);
    expect(isFamilyAdminRole('guest')).toBe(false);
  });

  it('an unknown or missing role gets nothing', () => {
    for (const value of [null, undefined, '', 'Admin', 'ADULT', 'owner', 'superuser']) {
      expect(isGrownUpRole(value)).toBe(false);
      expect(isFamilyAdminRole(value)).toBe(false);
    }
  });
});
