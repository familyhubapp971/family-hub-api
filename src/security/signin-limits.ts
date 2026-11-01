// FHS-695: per-email limits on the /auth/v1 pass-through to GoTrue, whose own
// limits are coarse. Two rules:
//   - emails: at most `emailsPerHour` sign-in emails to one address per hour;
//   - tries: after `maxFailedAttempts` failed password or code tries in a row,
//     that address is locked for `lockoutMs`. A success clears the count.
// Held in process memory, like the kid PIN lockout: one api instance today.
// Addresses are keyed without any +tag, since name+1@ and name+2@ usually
// reach the same inbox.

/** The limiter's key for an address: lower-case, with any +tag removed. */
export function limitKey(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at <= 0) return lower;
  const local = lower.slice(0, at).split('+')[0] || lower.slice(0, at);
  return `${local}${lower.slice(at)}`;
}

export interface SignInLimitsOptions {
  maxFailedAttempts: number;
  lockoutMs: number;
  emailsPerHour: number;
  now?: () => number;
}

export type Blocked = { blocked: true; retryAfterMs: number };
export type Allowed = { blocked: false };
export type EmailAllowed = { blocked: false; sentAt: number };

const HOUR_MS = 60 * 60_000;
const MAX_TRACKED = 50_000;

interface TryState {
  failures: number;
  lockedUntil: number;
  lastFailureAt: number;
}

export class SignInLimits {
  private readonly tries = new Map<string, TryState>();
  private readonly emails = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(private readonly opts: SignInLimitsOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Call before sending a sign-in email. Counts the send when allowed. */
  takeEmail(email: string): EmailAllowed | Blocked {
    const key = limitKey(email);
    const now = this.now();
    const recent = (this.emails.get(key) ?? []).filter((t) => now - t < HOUR_MS);
    if (recent.length >= this.opts.emailsPerHour) {
      this.emails.set(key, recent);
      return { blocked: true, retryAfterMs: HOUR_MS - (now - recent[0]!) };
    }
    recent.push(now);
    this.touch(this.emails, key, recent);
    return { blocked: false, sentAt: now };
  }

  /** Gives back the email counted at `sentAt` when GoTrue failed and sent nothing. */
  refundEmail(email: string, sentAt: number): void {
    const recent = this.emails.get(limitKey(email));
    const i = recent ? recent.lastIndexOf(sentAt) : -1;
    if (recent && i !== -1) recent.splice(i, 1);
  }

  /** Call before a password or code try. */
  checkTry(email: string): Allowed | Blocked {
    const state = this.tries.get(limitKey(email));
    const now = this.now();
    if (state && state.lockedUntil > now) {
      return { blocked: true, retryAfterMs: state.lockedUntil - now };
    }
    return { blocked: false };
  }

  /** Call with GoTrue's answer to a password or code try. */
  recordTry(email: string, succeeded: boolean): void {
    const key = limitKey(email);
    if (succeeded) {
      this.tries.delete(key);
      return;
    }
    const now = this.now();
    const prev = this.tries.get(key);
    // A run of failures that went quiet for a full lockout period starts over.
    const stale = !prev || now - prev.lastFailureAt > this.opts.lockoutMs;
    const failures = stale ? 1 : prev.failures + 1;
    const lockedUntil = failures >= this.opts.maxFailedAttempts ? now + this.opts.lockoutMs : 0;
    this.touch(this.tries, key, {
      failures: lockedUntil ? 0 : failures,
      lockedUntil,
      lastFailureAt: now,
    });
  }

  // Re-inserting moves the key to the end, so trim() drops the least recently
  // used addresses, never one that is under attack right now.
  private touch<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    this.trim(map);
  }

  // Bounded memory: drop the least recently used entries if addresses are sprayed.
  private trim(map: Map<string, unknown>): void {
    while (map.size > MAX_TRACKED) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
