// FHS-672: the founder page token.
import { describe, it, expect } from 'vitest';
import {
  issueFounderToken,
  verifyFounderToken,
} from '../../../../../apps/api/src/areas/admin/founder.js';

const NOW = 1_800_000_000_000;
const F = { passcode: '246810', secret: 'test-secret-that-is-at-least-32-characters' };

describe('founder page token', () => {
  it('opens the page with the passcode that issued it', () => {
    expect(verifyFounderToken(F, issueFounderToken(F, NOW), NOW + 1000)).toBe(true);
  });

  it('stops working after 8 hours', () => {
    const token = issueFounderToken(F, NOW);
    expect(verifyFounderToken(F, token, NOW + 8 * 60 * 60_000)).toBe(false);
  });

  it('stops working when the passcode changes', () => {
    expect(verifyFounderToken({ ...F, passcode: '135791' }, issueFounderToken(F, NOW), NOW)).toBe(
      false,
    );
  });

  it('refuses a token with a stretched expiry', () => {
    const [, sig] = issueFounderToken(F, NOW).split('.');
    expect(verifyFounderToken(F, `${NOW + 99 * 60 * 60_000}.${sig}`, NOW)).toBe(false);
  });

  it('refuses rubbish', () => {
    expect(verifyFounderToken(F, 'not-a-token', NOW)).toBe(false);
    expect(verifyFounderToken(F, '', NOW)).toBe(false);
  });

  it('cannot be checked without the server secret', () => {
    const token = issueFounderToken(F, NOW);
    expect(
      verifyFounderToken({ ...F, secret: 'another-secret-also-32-characters-long' }, token, NOW),
    ).toBe(false);
  });
});
