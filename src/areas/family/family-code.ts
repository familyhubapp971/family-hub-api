import { randomBytes } from 'node:crypto';

// FHS-715: every family's private code, e.g. "e29b-41d4". It is the family's
// address (its slug) and the code kids type once on a tablet. Made by us from
// 4 random bytes, so there are about 4 billion of them: impossible to guess,
// and two families with the same surname never clash.

export const FAMILY_CODE_RE = /^[0-9a-f]{4}-[0-9a-f]{4}$/;

export function generateFamilyCode(): string {
  const hex = randomBytes(4).toString('hex');
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

export function isFamilyCode(value: string): boolean {
  return FAMILY_CODE_RE.test(value);
}
