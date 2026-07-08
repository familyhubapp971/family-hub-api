import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

// FHS-445 — calendar sync via a per-family "subscribe link" (iCalendar/ICS feed).
//
// The subscribe URL carries a signed token instead of a database-stored one, so
// the public feed endpoint can resolve + authorise a family with a single
// tenants read and no cross-tenant lookup:
//
//   token = "<tenantId>.<sig>"
//   sig   = base64url( HMAC-SHA256( "<tenantId>:<feedKey>", CALENDAR_FEED_SECRET ) )
//
// `feedKey` is a per-family secret (tenants.calendar_feed_key). Rotating it
// (regenerate the link) changes every signature → old subscriptions 404. The
// global CALENDAR_FEED_SECRET means a leaked feedKey alone can't forge a token.
//
// The token is a bearer credential (a family's schedule is sensitive on a
// kids' product), so verification is constant-time and happens BEFORE any
// event row is read — a forged/edited token never reaches the calendar data.

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A fresh per-family feed key. 32 random bytes, URL-safe. */
export function generateFeedKey(): string {
  return randomBytes(32).toString('base64url');
}

function signature(tenantId: string, feedKey: string, secret: string): string {
  return createHmac('sha256', secret).update(`${tenantId}:${feedKey}`).digest('base64url');
}

/** The full subscribe token for a family: `<tenantId>.<sig>`. */
export function signFeedToken(tenantId: string, feedKey: string, secret: string): string {
  return `${tenantId}.${signature(tenantId, feedKey, secret)}`;
}

/**
 * Split an untrusted token into its parts WITHOUT trusting it. Strips an
 * optional `.ics` suffix (calendar apps append it). Returns null for anything
 * malformed so the caller 404s without a DB hit. The returned tenantId is only
 * a claim until {@link verifyFeedSignature} confirms it.
 */
export function parseFeedToken(raw: string): { tenantId: string; sig: string } | null {
  const token = raw.endsWith('.ics') ? raw.slice(0, -4) : raw;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const tenantId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!UUID_RE.test(tenantId) || sig.length === 0) return null;
  return { tenantId, sig };
}

/**
 * Constant-time check that `sig` is the real signature for this family. Returns
 * false (never throws) on any mismatch or missing key, so a bad token is always
 * a plain 404.
 */
export function verifyFeedSignature(
  tenantId: string,
  feedKey: string | null,
  sig: string,
  secret: string,
): boolean {
  if (!feedKey) return false;
  const expected = Buffer.from(signature(tenantId, feedKey, secret));
  let provided: Buffer;
  try {
    provided = Buffer.from(sig);
  } catch {
    return false;
  }
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

// ─── ICS generation ─────────────────────────────────────────────────────────

/** One family activity, in the shape the feed needs (subset of the events row). */
export interface FeedEvent {
  id: string;
  date: string; // YYYY-MM-DD
  startTime: string | null; // HH:MM(:SS)? or null for an all-day event
  endTime: string | null;
  title: string;
  notes: string | null;
  location: string | null;
  updatedAt: Date | string;
}

// Escape per RFC 5545 §3.3.11: backslash, semicolon, comma, and newlines.
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// Fold lines to <=75 octets per RFC 5545 §3.1 (CRLF + a leading space on
// continuations). We measure bytes, not chars, so multi-byte titles fold safely.
function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const chunks: string[] = [];
  let start = 0;
  // First line 75 octets, continuations 74 (the leading space counts).
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Don't split a multi-byte UTF-8 sequence: back up off continuation bytes.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    chunks.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74;
  }
  return chunks.join('\r\n ');
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// UTC timestamp form: YYYYMMDDTHHMMSSZ (used for DTSTAMP).
function toUtcStamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

// The offset (ms) of an IANA timezone at a given UTC instant, computed via Intl
// (no dependency). Returns 0 for an unknown/invalid zone so we degrade to UTC
// rather than throw. Positive east of UTC (Asia/Dubai → +4h).
function tzOffsetMs(tz: string, at: Date): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);
  } catch {
    return 0;
  }
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') m[p.type] = Number(p.value);
  const asUtc = Date.UTC(m.year!, m.month! - 1, m.day!, m.hour!, m.minute!, m.second!);
  return asUtc - at.getTime();
}

// Convert a wall-clock date+time IN the family's timezone to the absolute UTC
// instant, so every timed event is emitted as `...Z` and renders at the right
// local time in EVERY calendar app (Google, Apple, and Outlook — which
// mishandles bare IANA TZIDs). Two-step to settle DST offset boundaries.
function zonedWallTimeToUtc(date: string, time: string, tz: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const [h = 0, mi = 0, s = 0] = time.split(':').map(Number);
  const guess = Date.UTC(y!, mo! - 1, d!, h, mi, s);
  const off1 = tzOffsetMs(tz, new Date(guess));
  const off2 = tzOffsetMs(tz, new Date(guess - off1));
  return new Date(guess - off2);
}

// Date-only value for all-day events: YYYYMMDD.
function toDateValue(date: string): string {
  return date.replace(/-/g, '');
}

// Add one day to a YYYY-MM-DD string (all-day DTEND is exclusive per RFC 5545).
function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export interface BuildIcsOptions {
  events: FeedEvent[];
  familyName: string;
  tzid: string; // IANA timezone, e.g. "Europe/London"
  now: Date; // injected for deterministic DTSTAMP in tests
}

/**
 * Build a valid VCALENDAR document from a family's activities. Timed events use
 * local date-times tagged with the family TZID; a row with no startTime is an
 * all-day VEVENT (DTSTART;VALUE=DATE .. DTEND next day, exclusive).
 */
export function buildIcs({ events, familyName, tzid, now }: BuildIcsOptions): string {
  // Defence in depth: `tzid` becomes an ICS property parameter (DTSTART;TZID=…),
  // which escapeText can't safely quote. Onboarding already regex-locks the
  // timezone, but validate here too so a future looser write path can't inject
  // CRLF / extra properties into every subscriber's calendar. Fall back to UTC.
  const safeTzid = /^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tzid) ? tzid : 'UTC';
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//FamilyHub//Calendar Sync//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(familyName)}`,
    `X-WR-TIMEZONE:${safeTzid}`,
  ];
  const stamp = toUtcStamp(now);
  for (const ev of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${ev.id}@familyhub`);
    lines.push(`DTSTAMP:${stamp}`);
    const seq = new Date(ev.updatedAt).getTime();
    if (Number.isFinite(seq)) lines.push(`SEQUENCE:${Math.floor(seq / 1000)}`);
    if (ev.startTime) {
      lines.push(`DTSTART:${toUtcStamp(zonedWallTimeToUtc(ev.date, ev.startTime, safeTzid))}`);
      const end = ev.endTime ?? ev.startTime;
      lines.push(`DTEND:${toUtcStamp(zonedWallTimeToUtc(ev.date, end, safeTzid))}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${toDateValue(ev.date)}`);
      lines.push(`DTEND;VALUE=DATE:${toDateValue(nextDay(ev.date))}`);
    }
    lines.push(`SUMMARY:${escapeText(ev.title)}`);
    if (ev.notes) lines.push(`DESCRIPTION:${escapeText(ev.notes)}`);
    if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// How far back the feed reaches, so it stays bounded as a family accrues years
// of history (future events are always included). Exported for testing the
// boundary. Returns a YYYY-MM-DD string `days` before `now` (UTC).
export function feedCutoffDate(now: Date, days: number): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
