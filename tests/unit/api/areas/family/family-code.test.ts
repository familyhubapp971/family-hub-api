import { describe, expect, it } from 'vitest';
import { generateFamilyCode, isFamilyCode } from '../../../../../src/areas/family/family-code.js';

describe('FHS-715: family codes', () => {
  it('looks like e29b-41d4', () => {
    expect(generateFamilyCode()).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/);
  });

  it('is different for every family', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateFamilyCode()));
    expect(codes.size).toBe(500);
  });

  it('tells a code from an old surname address', () => {
    expect(isFamilyCode('e29b-41d4')).toBe(true);
    expect(isFamilyCode('smith')).toBe(false);
  });
});
