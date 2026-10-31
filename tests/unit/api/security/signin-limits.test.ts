import { describe, it, expect } from 'vitest';
import { SignInLimits, limitKey } from '../../../../src/security/signin-limits.js';

// FHS-695: per-email sign-in limits on the GoTrue pass-through.

function limits(start = 0) {
  let t = start;
  const l = new SignInLimits({
    maxFailedAttempts: 5,
    lockoutMs: 15 * 60_000,
    emailsPerHour: 5,
    now: () => t,
  });
  return { l, advance: (ms: number) => (t += ms) };
}

describe('FHS-695: sign-in tries', () => {
  it('locks an address after 5 failed tries in a row', () => {
    const { l } = limits();
    for (let i = 0; i < 4; i++) l.recordTry('a@b.com', false);
    expect(l.checkTry('a@b.com').blocked).toBe(false);
    l.recordTry('a@b.com', false);
    const verdict = l.checkTry('a@b.com');
    expect(verdict).toEqual({ blocked: true, retryAfterMs: 15 * 60_000 });
  });

  it('treats the address case-insensitively', () => {
    const { l } = limits();
    for (let i = 0; i < 5; i++) l.recordTry('A@B.com', false);
    expect(l.checkTry('a@b.COM').blocked).toBe(true);
  });

  it('lets the address try again once the lockout has passed', () => {
    const { l, advance } = limits();
    for (let i = 0; i < 5; i++) l.recordTry('a@b.com', false);
    advance(15 * 60_000 + 1);
    expect(l.checkTry('a@b.com').blocked).toBe(false);
    l.recordTry('a@b.com', false);
    expect(l.checkTry('a@b.com').blocked).toBe(false);
  });

  it('clears the count after a successful try', () => {
    const { l } = limits();
    for (let i = 0; i < 4; i++) l.recordTry('a@b.com', false);
    l.recordTry('a@b.com', true);
    for (let i = 0; i < 4; i++) l.recordTry('a@b.com', false);
    expect(l.checkTry('a@b.com').blocked).toBe(false);
  });

  it('never blocks a different address', () => {
    const { l } = limits();
    for (let i = 0; i < 5; i++) l.recordTry('a@b.com', false);
    expect(l.checkTry('c@d.com').blocked).toBe(false);
  });
});

describe('FHS-695: sign-in emails', () => {
  it('allows 5 emails an hour to one address, then blocks until the oldest expires', () => {
    const { l, advance } = limits();
    for (let i = 0; i < 5; i++) {
      expect(l.takeEmail('a@b.com').blocked).toBe(false);
      advance(60_000);
    }
    const verdict = l.takeEmail('a@b.com');
    expect(verdict.blocked).toBe(true);
    expect(verdict.blocked && verdict.retryAfterMs).toBe(55 * 60_000);
    advance(55 * 60_000);
    expect(l.takeEmail('a@b.com').blocked).toBe(false);
  });

  it('gives back exactly the email that was not sent', () => {
    const { l, advance } = limits();
    const sent: number[] = [];
    for (let i = 0; i < 5; i++) {
      const v = l.takeEmail('a@b.com');
      if (!v.blocked) sent.push(v.sentAt);
      advance(1000);
    }
    l.refundEmail('A@b.com', sent[2]!);
    expect(l.takeEmail('a@b.com').blocked).toBe(false);
    expect(l.takeEmail('a@b.com').blocked).toBe(true);
  });

  it('shares one allowance across +tag spellings of an address', () => {
    const { l } = limits();
    for (let i = 0; i < 5; i++) l.takeEmail(`parent+${i}@gmail.com`);
    expect(l.takeEmail('Parent@gmail.com').blocked).toBe(true);
  });

  it('counts each address separately', () => {
    const { l } = limits();
    for (let i = 0; i < 5; i++) l.takeEmail('a@b.com');
    expect(l.takeEmail('c@d.com').blocked).toBe(false);
  });
});

describe('FHS-695: limitKey', () => {
  it('lower-cases and drops any +tag', () => {
    expect(limitKey(' Parent+School@Gmail.com ')).toBe('parent@gmail.com');
    expect(limitKey('a@b.com')).toBe('a@b.com');
    expect(limitKey('+x@b.com')).toBe('+x@b.com');
  });
});
