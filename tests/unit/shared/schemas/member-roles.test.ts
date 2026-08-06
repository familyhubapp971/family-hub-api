// FHS-569: the "is this member a kid?" rule was hand-rolled in six places
// and one of them checked only 'child', so teens vanished from the profile
// menu. One helper now answers it everywhere.
import { describe, it, expect } from 'vitest';
import {
  isKidRole,
  isPinEligibleRole,
  KID_ROLES,
  MEMBER_ROLES,
} from '../../../../packages/shared/src/schemas/member-roles';

describe('isKidRole', () => {
  it('counts a child as a kid', () => {
    expect(isKidRole('child')).toBe(true);
  });

  // The regression this file exists for.
  it('counts a teen as a kid', () => {
    expect(isKidRole('teen')).toBe(true);
  });

  it.each(['admin', 'adult', 'guest'])('does not count %s as a kid', (role) => {
    expect(isKidRole(role)).toBe(false);
  });

  it('treats an unknown, empty or missing role as not a kid', () => {
    expect(isKidRole('wizard')).toBe(false);
    expect(isKidRole('')).toBe(false);
    expect(isKidRole(null)).toBe(false);
    expect(isKidRole(undefined)).toBe(false);
  });

  it('agrees with the exported set', () => {
    for (const role of MEMBER_ROLES) {
      expect(isKidRole(role)).toBe(KID_ROLES.has(role));
    }
  });
});

describe('isPinEligibleRole', () => {
  it('lets children and teens sign in with a PIN', () => {
    expect(isPinEligibleRole('child')).toBe(true);
    expect(isPinEligibleRole('teen')).toBe(true);
  });

  it('does not let adults sign in with a PIN', () => {
    expect(isPinEligibleRole('adult')).toBe(false);
    expect(isPinEligibleRole('admin')).toBe(false);
  });
});
