import type { MiddlewareHandler } from 'hono';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('rate-limit');

// In-memory token bucket per key (IP for Sprint 0; tenant id later).
// Sprint 2 swaps the store for Redis (ADR-pending) so a single VU's
// bucket survives across api replicas.
//
// Token model: each key gets `capacity` tokens. Each request consumes 1.
// Buckets refill linearly at `refillPerSecond = capacity / windowSec`.
// Steady-state allows `capacity` requests per `windowSec` with bursts up
// to the full bucket. For "100 req/min" the bucket holds 100 and refills
// at ~1.67/s — exactly the AC #3 contract.

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

interface Options {
  capacity: number;
  windowMs: number;
  /** Override how a key is derived from the request. Default: client IP. */
  keyFor?: (clientIp: string | undefined) => string;
}

const buckets = new Map<string, Bucket>();
// Idle bucket sweep — keeps memory bounded under heavy churn (e.g. botnets).
const SWEEP_INTERVAL_MS = 5 * 60_000;
let sweepTimer: ReturnType<typeof setInterval> | undefined;
let warnedMissingIp = false;

function sweepIdle(now: number, idleMs: number): void {
  for (const [key, b] of buckets) {
    if (now - b.lastRefillMs > idleMs) buckets.delete(key);
  }
}

export function rateLimit({
  capacity,
  windowMs,
  keyFor = (ip) => ip ?? 'unknown',
}: Options): MiddlewareHandler {
  if (capacity <= 0) {
    // Disabled — no-op middleware for tests.
    return async (_c, next) => {
      await next();
    };
  }

  const refillPerMs = capacity / windowMs;

  if (!sweepTimer && typeof setInterval !== 'undefined') {
    sweepTimer = setInterval(() => sweepIdle(Date.now(), windowMs * 4), SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  return async (c, next) => {
    // /health is exempt — Railway's internal probe hits the container
    // direct (no x-forwarded-for), and rate-limiting health checks at
    // 100 req/min would block 1-second probes within seconds anyway.
    if (c.req.path === '/health') {
      await next();
      return;
    }

    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      c.req.header('x-real-ip') ||
      undefined;

    // Fail-closed in non-dev when we can't identify the caller. A
    // missing forwarded-for header in production usually means the proxy
    // chain is misconfigured (header stripped, direct exposure) —
    // collapsing all traffic into one 'unknown' bucket would let 100
    // req/min lock the whole world out.
    if (!ip && config.NODE_ENV !== 'development' && config.NODE_ENV !== 'test') {
      if (!warnedMissingIp) {
        log.warn(
          'rate-limit: client IP could not be derived (no x-forwarded-for / x-real-ip) — rejecting request. Check the proxy config.',
        );
        warnedMissingIp = true;
      }
      return c.json({ error: 'rate limit: client identity unavailable' }, 429);
    }

    const key = keyFor(ip);
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefillMs: now };
      buckets.set(key, bucket);
    } else {
      const elapsed = now - bucket.lastRefillMs;
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
      bucket.lastRefillMs = now;
    }

    if (bucket.tokens < 1) {
      const retryAfterSec = Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000));
      c.header('Retry-After', String(retryAfterSec));
      c.header('X-RateLimit-Limit', String(capacity));
      c.header('X-RateLimit-Remaining', '0');
      return c.json({ error: 'rate limit exceeded' }, 429);
    }

    bucket.tokens -= 1;
    c.header('X-RateLimit-Limit', String(capacity));
    c.header('X-RateLimit-Remaining', String(Math.floor(bucket.tokens)));
    await next();
  };
}

// Test-only — clears all buckets so a Vitest run doesn't carry state across tests.
export function _resetRateLimitForTests(): void {
  buckets.clear();
}
