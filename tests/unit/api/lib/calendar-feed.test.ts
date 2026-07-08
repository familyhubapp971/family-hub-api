import { describe, expect, it } from 'vitest';
import {
  buildIcs,
  feedCutoffDate,
  generateFeedKey,
  parseFeedToken,
  signFeedToken,
  verifyFeedSignature,
  type FeedEvent,
} from '../../../../apps/api/src/lib/calendar-feed.js';

// FHS-445 — calendar sync: signed subscribe tokens + ICS generation.

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const SECRET = 'a'.repeat(32);
const OTHER_SECRET = 'b'.repeat(32);

describe('generateFeedKey', () => {
  it('returns a non-empty, URL-safe key that differs on every call', () => {
    const a = generateFeedKey();
    const b = generateFeedKey();
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('signFeedToken + parseFeedToken + verifyFeedSignature — round trip', () => {
  it('parses the tenantId back out of a freshly signed token', () => {
    const feedKey = generateFeedKey();
    const token = signFeedToken(TENANT_ID, feedKey, SECRET);
    const parsed = parseFeedToken(token);
    expect(parsed).not.toBeNull();
    expect(parsed!.tenantId).toBe(TENANT_ID);
  });

  it('verifies true for the matching tenantId, feedKey, and secret', () => {
    const feedKey = generateFeedKey();
    const token = signFeedToken(TENANT_ID, feedKey, SECRET);
    const parsed = parseFeedToken(token)!;
    expect(verifyFeedSignature(parsed.tenantId, feedKey, parsed.sig, SECRET)).toBe(true);
  });
});

describe('verifyFeedSignature — tamper + mismatch cases', () => {
  const feedKey = generateFeedKey();
  const token = signFeedToken(TENANT_ID, feedKey, SECRET);
  const parsed = parseFeedToken(token)!;

  it('rejects an altered signature', () => {
    const tamperedSig = parsed.sig.slice(0, -1) + (parsed.sig.at(-1) === 'A' ? 'B' : 'A');
    expect(verifyFeedSignature(parsed.tenantId, feedKey, tamperedSig, SECRET)).toBe(false);
  });

  it('rejects a different signing secret', () => {
    expect(verifyFeedSignature(parsed.tenantId, feedKey, parsed.sig, OTHER_SECRET)).toBe(false);
  });

  it('rejects a different feedKey (e.g. after rotation)', () => {
    const rotatedKey = generateFeedKey();
    expect(verifyFeedSignature(parsed.tenantId, rotatedKey, parsed.sig, SECRET)).toBe(false);
  });

  it('rejects a null feedKey (family never generated one)', () => {
    expect(verifyFeedSignature(parsed.tenantId, null, parsed.sig, SECRET)).toBe(false);
  });

  it('rejects a signature that was actually issued for a different tenant', () => {
    const otherToken = signFeedToken(OTHER_TENANT_ID, feedKey, SECRET);
    const otherParsed = parseFeedToken(otherToken)!;
    // Same feedKey/secret, but sig was computed against OTHER_TENANT_ID.
    expect(verifyFeedSignature(TENANT_ID, feedKey, otherParsed.sig, SECRET)).toBe(false);
  });
});

describe('parseFeedToken — malformed input', () => {
  const feedKey = generateFeedKey();
  const token = signFeedToken(TENANT_ID, feedKey, SECRET);

  it('strips a trailing .ics suffix', () => {
    const parsed = parseFeedToken(`${token}.ics`);
    expect(parsed).not.toBeNull();
    expect(parsed!.tenantId).toBe(TENANT_ID);
  });

  it('returns null when there is no dot separator', () => {
    expect(parseFeedToken('nodothere')).toBeNull();
  });

  it('returns null when the signature segment is empty', () => {
    expect(parseFeedToken(`${TENANT_ID}.`)).toBeNull();
  });

  it('returns null when the tenant segment is not a UUID', () => {
    expect(parseFeedToken('not-a-uuid.somesignature')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseFeedToken('')).toBeNull();
  });
});

describe('buildIcs', () => {
  const NOW = new Date('2026-07-01T00:00:00Z');

  function baseEvent(overrides: Partial<FeedEvent> = {}): FeedEvent {
    return {
      id: '33333333-3333-4333-8333-333333333333',
      date: '2026-07-05',
      startTime: null,
      endTime: null,
      title: 'Swim class',
      notes: null,
      location: null,
      updatedAt: NOW,
      ...overrides,
    };
  }

  it('opens with BEGIN:VCALENDAR / VERSION:2.0 and closes with END:VCALENDAR', () => {
    const ics = buildIcs({ events: [], familyName: 'Khan Family', tzid: 'UTC', now: NOW });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('VERSION:2.0');
    expect(ics.trim().endsWith('END:VCALENDAR')).toBe(true);
  });

  it('still yields a valid VCALENDAR with an empty events array', () => {
    const ics = buildIcs({ events: [], familyName: 'Khan Family', tzid: 'UTC', now: NOW });
    expect(ics).not.toContain('BEGIN:VEVENT');
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.trim().endsWith('END:VCALENDAR')).toBe(true);
  });

  it('emits an all-day event with DTSTART;VALUE=DATE and DTEND one day later', () => {
    const ics = buildIcs({
      events: [baseEvent({ date: '2026-07-05', startTime: null })],
      familyName: 'Khan Family',
      tzid: 'Europe/London',
      now: NOW,
    });
    expect(ics).toContain('DTSTART;VALUE=DATE:20260705');
    // All-day DTEND is exclusive — the next calendar day.
    expect(ics).toContain('DTEND;VALUE=DATE:20260706');
  });

  it('emits a timed event as a UTC instant (Z), no bare TZID (Outlook-safe)', () => {
    // A UTC family: 09:00 wall time stays 09:00Z.
    const ics = buildIcs({
      events: [baseEvent({ date: '2026-07-05', startTime: '09:00', endTime: '10:30' })],
      familyName: 'Khan Family',
      tzid: 'UTC',
      now: NOW,
    });
    expect(ics).toContain('DTSTART:20260705T090000Z');
    expect(ics).toContain('DTEND:20260705T103000Z');
    expect(ics).not.toContain('TZID=');
  });

  it('converts a London (BST, +1) wall time to the right UTC instant', () => {
    // July → British Summer Time (UTC+1): 09:00 London = 08:00 UTC.
    const ics = buildIcs({
      events: [baseEvent({ date: '2026-07-05', startTime: '09:00', endTime: '10:30' })],
      familyName: 'Khan Family',
      tzid: 'Europe/London',
      now: NOW,
    });
    expect(ics).toContain('DTSTART:20260705T080000Z');
    expect(ics).toContain('DTEND:20260705T093000Z');
  });

  it('converts a Dubai (+4, no DST) wall time to the right UTC instant', () => {
    // Asia/Dubai is UTC+4 year-round: 09:00 Dubai = 05:00 UTC.
    const ics = buildIcs({
      events: [baseEvent({ date: '2026-07-05', startTime: '09:00', endTime: '10:30' })],
      familyName: 'Khan Family',
      tzid: 'Asia/Dubai',
      now: NOW,
    });
    expect(ics).toContain('DTSTART:20260705T050000Z');
    expect(ics).toContain('DTEND:20260705T063000Z');
  });

  it('falls back to UTC for an unknown timezone instead of throwing', () => {
    const ics = buildIcs({
      events: [baseEvent({ date: '2026-07-05', startTime: '09:00', endTime: '10:30' })],
      familyName: 'Khan Family',
      tzid: 'Not/AZone',
      now: NOW,
    });
    expect(ics).toContain('DTSTART:20260705T090000Z');
  });

  it('escapes semicolons, commas, backslashes, and newlines in SUMMARY', () => {
    const ics = buildIcs({
      events: [baseEvent({ title: 'A; B, C\nD' })],
      familyName: 'Khan Family',
      tzid: 'UTC',
      now: NOW,
    });
    expect(ics).toContain('SUMMARY:A\\; B\\, C\\nD');
  });

  it('line-folds a title longer than 75 octets with a CRLF + leading space continuation', () => {
    const longTitle = 'x'.repeat(120);
    const ics = buildIcs({
      events: [baseEvent({ title: longTitle })],
      familyName: 'Khan Family',
      tzid: 'UTC',
      now: NOW,
    });
    expect(ics).toContain('SUMMARY:');
    // A folded continuation line always starts with a space right after CRLF.
    expect(ics).toMatch(/\r\n /);
  });
});

describe('feedCutoffDate — the 90-day past window boundary', () => {
  const NOW = new Date('2026-07-05T12:00:00Z');

  it('returns the date exactly N days before now (UTC)', () => {
    // 2026-07-05 minus 90 days = 2026-04-06. An event ON this date is included
    // (the route filters date >= cutoff); one the day before is excluded.
    expect(feedCutoffDate(NOW, 90)).toBe('2026-04-06');
    expect(feedCutoffDate(NOW, 0)).toBe('2026-07-05');
  });

  it('crosses month + year boundaries correctly', () => {
    expect(feedCutoffDate(new Date('2026-01-01T00:00:00Z'), 90)).toBe('2025-10-03');
  });
});
