import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { SignJWT } from 'jose';
import { config } from '../config.js';
import { getDb, pinRequestTenant } from '../db/client.js';
import { members, tenants } from '../db/schema.js';

// FHS-236: POST /api/auth/kid-pin.
//
// Family-shared-device auth path: a kid picks their avatar on
// /login, types a 4-digit PIN, and gets back a child-scoped JWT.
// Distinct from the parent (Supabase) auth path: this token is
// signed by the api with KID_AUTH_SECRET and carries `scope: 'child'`
// so middleware can grant kids access to child-tab routes only.
//
// Lockout: a per-memberId bucket counts failed PINs. After
// KID_PIN_LOCKOUT_MAX_ATTEMPTS the bucket returns 429 for
// KID_PIN_LOCKOUT_MS. Keying on memberId only (not on ip) means an
// attacker who rotates X-Forwarded-For can't sidestep the lockout:
// the realistic UX cost is that one kid's typo storm cools off that
// kid (only) for 15 min, which is the intended behaviour.
//
// Bucket lives in process memory: fine for the single-replica
// bootstrap api; tracked under FHS-205 to move to Redis when we
// scale to multiple api replicas.
//
// IMPORTANT for the future kid-JWT verifier middleware: when the
// consumer middleware lands, it MUST pass `{ algorithms: ['HS256'],
// issuer: 'family-hub-kid-auth' }` to jose.jwtVerify so a forged
// `alg: 'none'` token or an algorithm-confusion attack is rejected.

export const kidPinRequestSchema = z.object({
  tenantSlug: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'invalid tenant slug'),
  memberId: z.string().uuid('memberId must be a UUID'),
  pin: z.string().regex(/^\d{4}$/, 'pin must be exactly 4 digits'),
});

export const kidPinResponseSchema = z.object({
  token: z.string(),
  member: z.object({
    id: z.string().uuid(),
    displayName: z.string(),
    avatarEmoji: z.string().nullable(),
    tenantId: z.string().uuid(),
    tenantSlug: z.string(),
  }),
  expiresAt: z.string().datetime(),
});

export type KidPinResponse = z.infer<typeof kidPinResponseSchema>;

// Lockout bucket. Keyed on memberId only: see header comment for why.
interface Bucket {
  attempts: number;
  lockedUntil: number; // epoch ms; 0 = not locked
}
const buckets = new Map<string, Bucket>();

/** Test hook: clears the lockout map between scenarios. */
export function _resetKidPinBucketsForTests(): void {
  buckets.clear();
}

/**
 * FHS-252: public hook for the members admin endpoint. When an admin
 * resets a kid's PIN (or clears it entirely), the per-memberId
 * lockout bucket must be cleared too so a kid who tripped the
 * 5-attempts cooldown can immediately try again with the new PIN.
 * Distinct from the test-only helper above which wipes everything.
 */
export function resetKidPinBucketForMember(memberId: string): void {
  buckets.delete(memberId);
}

function isLocked(bucket: Bucket | undefined, now: number): boolean {
  return !!bucket && bucket.lockedUntil > now;
}

function recordFail(memberId: string, now: number): Bucket {
  const b = buckets.get(memberId) ?? { attempts: 0, lockedUntil: 0 };
  b.attempts += 1;
  if (b.attempts >= config.KID_PIN_LOCKOUT_MAX_ATTEMPTS) {
    b.lockedUntil = now + config.KID_PIN_LOCKOUT_MS;
    b.attempts = 0; // reset counter: next failure post-cooldown starts fresh
  }
  buckets.set(memberId, b);
  return b;
}

function clearBucket(memberId: string): void {
  buckets.delete(memberId);
}

// Sweep buckets whose lockout has fully expired AND haven't seen a
// recent failure. Without this, every memberId that ever fails stays
// in the map forever. Runs lazily on each request: cheap, bounded,
// no separate timer needed.
function sweepExpiredBuckets(now: number): void {
  for (const [k, b] of buckets) {
    if (b.lockedUntil > 0 && b.lockedUntil <= now && b.attempts === 0) {
      buckets.delete(k);
    }
  }
}

// A real bcrypt hash used for the timing-equalisation compare when the
// caller hits a non-existent / ineligible member. Generated once at
// module load with the same cost factor PIN writers use, so the
// constant-time defence actually matches a real comparison's cost.
export const KID_PIN_BCRYPT_COST = 10;
const DUMMY_PIN_HASH = bcrypt.hashSync('never-matches', KID_PIN_BCRYPT_COST);

async function signKidJwt(input: {
  memberId: string;
  tenantId: string;
  tenantSlug: string;
  expiresAtMs: number;
}): Promise<string> {
  const secret = new TextEncoder().encode(config.KID_AUTH_SECRET);
  return new SignJWT({
    scope: 'child',
    tenantId: input.tenantId,
    tenantSlug: input.tenantSlug,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(input.memberId)
    .setIssuedAt()
    .setIssuer('family-hub-kid-auth')
    .setExpirationTime(Math.floor(input.expiresAtMs / 1000))
    .sign(secret);
}

export const kidPinRouter = new Hono().post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as unknown;
  const parsed = kidPinRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'invalid request',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    );
  }

  const now = Date.now();
  sweepExpiredBuckets(now);
  const bucket = buckets.get(parsed.data.memberId);
  if (isLocked(bucket, now)) {
    const retryAfterSec = Math.ceil((bucket!.lockedUntil - now) / 1000);
    c.header('Retry-After', String(retryAfterSec));
    return c.json(
      {
        error: 'too many attempts',
        errorCode: 'KID_PIN_LOCKED',
        retryAfter: retryAfterSec,
      },
      429,
    );
  }

  const db = getDb();

  // Resolve the tenant by slug + the member by id within that tenant.
  // Two lookups instead of a JOIN so the auth flow can fail with a
  // single specific 401 ("invalid login") regardless of which step
  // missed: the public-facing message must not enumerate.
  const [tenantRow] = await db
    .select({ id: tenants.id, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.slug, parsed.data.tenantSlug))
    .limit(1);

  // FHS-354: pin the resolved tenant so the members read passes RLS once the
  // app runs as app_runtime (the slug is the boundary on this public route).
  if (tenantRow) await pinRequestTenant(tenantRow.id);

  const [memberRow] = tenantRow
    ? await db
        .select({
          id: members.id,
          displayName: members.displayName,
          avatarEmoji: members.avatarEmoji,
          isChild: members.isChild,
          pinHash: members.pinHash,
        })
        .from(members)
        .where(and(eq(members.tenantId, tenantRow.id), eq(members.id, parsed.data.memberId)))
        .limit(1)
    : [undefined];

  // Fail-closed when ANY of: tenant missing, member missing, member
  // not flagged as a kid, or no PIN set. Same generic 401 in every
  // case: never reveal which check failed.
  const eligible = !!tenantRow && !!memberRow && memberRow.isChild && !!memberRow.pinHash;
  // Always run bcrypt.compare on a real hash with the same cost so an
  // attacker can't time-side-channel "this kid id is real": the
  // dummy hash is generated once at module load above.
  const passwordOk = await bcrypt.compare(
    parsed.data.pin,
    eligible ? memberRow!.pinHash! : DUMMY_PIN_HASH,
  );

  if (!eligible || !passwordOk) {
    recordFail(parsed.data.memberId, now);
    return c.json(
      {
        error: 'invalid login',
        errorCode: 'KID_PIN_INVALID',
      },
      401,
    );
  }

  // Success: clear the bucket + issue a short-lived JWT.
  clearBucket(parsed.data.memberId);
  const expiresAtMs = now + config.KID_JWT_TTL_MS;
  const token = await signKidJwt({
    memberId: memberRow!.id,
    tenantId: tenantRow!.id,
    tenantSlug: tenantRow!.slug,
    expiresAtMs,
  });

  const response: KidPinResponse = {
    token,
    member: {
      id: memberRow!.id,
      displayName: memberRow!.displayName,
      avatarEmoji: memberRow!.avatarEmoji,
      tenantId: tenantRow!.id,
      tenantSlug: tenantRow!.slug,
    },
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
  return c.json(kidPinResponseSchema.parse(response), 200);
});
