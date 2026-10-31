import { createHmac, scryptSync, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config.js';
import { getDb } from '../../database/client.js';
import { createLogger } from '../../services/logger.js';

// FHS-672: the founder's /admin feedback page.
//
//   POST /api/founder/session   { passcode } -> { token, expiresAt }
//   GET  /api/founder/feedback  x-founder-token -> every family's feedback
//
// No parent sign-in: the passcode (FOUNDER_PASSCODE, a server setting) is the
// credential. Unset means both routes answer 404.
//
// Lockout is ONE bucket for everyone, not per IP: an attacker can rotate
// X-Forwarded-For, but cannot get past a shared count. Five wrong tries lock
// the page for 15 minutes, so a 6-digit passcode takes years to guess. The
// cost is that a stranger guessing can lock the founder out for 15 minutes.
//
// The body is read BEFORE the lockout check, so the check, the comparison and
// the failure count run with no await between them: a burst of parallel
// guesses cannot all slip past the check before the first failure counts.
//
// The token is "<expiry>.<HMAC>", signed with FOUNDER_TOKEN_SECRET (a long
// random server secret) over a scrypt hash of the passcode and the expiry. A leaked
// token therefore cannot be brute-forced offline to recover the passcode, and
// changing the passcode still signs everyone out.

const log = createLogger('founder');

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60_000;
const TOKEN_TTL_MS = 8 * 60 * 60_000;
const FEEDBACK_LIMIT = 2000;

const lockout = { failures: 0, lockedUntil: 0 };

/** Test hook: clears the shared lockout between scenarios. */
export function _resetFounderLockoutForTests(): void {
  lockout.failures = 0;
  lockout.lockedUntil = 0;
}

// The passcode is only ever handled through scrypt (a deliberately slow
// password hash), salted with the server secret. The real passcode's value is
// worked out once and kept; each guess costs one scrypt run.
let cachedKey: { for: string; key: Buffer } | null = null;

function passcodeKey(f: FounderSecrets): Buffer {
  const id = `${f.secret}\0${f.passcode}`;
  if (cachedKey?.for !== id) cachedKey = { for: id, key: scryptSync(f.passcode, f.secret, 32) };
  return cachedKey.key;
}

function passcodeMatches(f: FounderSecrets, attempt: string): boolean {
  return timingSafeEqual(scryptSync(attempt, f.secret, 32), passcodeKey(f));
}

// The signing key is the server secret joined to the scrypt result, so a
// new passcode or a new secret both sign everyone out.
function sign(f: FounderSecrets, expiresAt: number): string {
  const key = Buffer.concat([Buffer.from(f.secret), passcodeKey(f)]);
  return createHmac('sha256', key).update(`founder:${expiresAt}`).digest('base64url');
}

function sameSignature(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface FounderSecrets {
  passcode: string;
  secret: string;
}

export function issueFounderToken(f: FounderSecrets, now = Date.now()): string {
  const expiresAt = now + TOKEN_TTL_MS;
  return `${expiresAt}.${sign(f, expiresAt)}`;
}

export function verifyFounderToken(f: FounderSecrets, token: string, now = Date.now()): boolean {
  const [exp, sig] = token.split('.');
  const expiresAt = Number(exp);
  if (!sig || !Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  return sameSignature(sig, sign(f, expiresAt));
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const founderSessionRequestSchema = z.object({
  passcode: z.string().min(1).max(32),
});

export const founderSessionResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.string().datetime(),
});

export const founderFeedbackRowSchema = z.object({
  source: z.enum(['in_app', 'screen', 'public']),
  familySlug: z.string().nullable(),
  familyName: z.string().nullable(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  visitId: z.string().nullable(),
  screen: z.string().nullable(),
  features: z.array(z.string()),
  pmfDisappointment: z.string().nullable(),
  recommendScore: z.number().int().nullable(),
  solvesProblem: z.number().int().nullable(),
  easeOfUse: z.number().int().nullable(),
  keepUsing: z.number().int().nullable(),
  painPoint: z.string().nullable(),
  featureRequest: z.string().nullable(),
  otherFeedback: z.string().nullable(),
  createdAt: z.string(),
});

export const founderFeedbackResponseSchema = z.object({
  rows: z.array(founderFeedbackRowSchema),
});

type FeedbackDbRow = Record<string, unknown> & {
  source: 'in_app' | 'screen' | 'public';
  family_slug: string | null;
  family_name: string | null;
  name: string | null;
  email: string | null;
  visit_id: string | null;
  screen: string | null;
  features: string[] | null;
  pmf_disappointment: string | null;
  recommend_score: number | null;
  solves_problem: number | null;
  ease_of_use: number | null;
  keep_using: number | null;
  pain_point: string | null;
  feature_request: string | null;
  other_feedback: string | null;
  created_at: Date | string;
};

// ─── Router ───────────────────────────────────────────────────────────────────

export function createFounderRouter(getSecrets: () => FounderSecrets | null) {
  return (
    new Hono()
      .post('/session', async (c) => {
        const f = getSecrets();
        if (!f) return c.json({ error: 'not found' }, 404);
        c.header('Cache-Control', 'no-store');

        // Read the body first: everything below runs without awaiting.
        const raw: unknown = await c.req.json().catch(() => null);

        const now = Date.now();
        if (lockout.lockedUntil > now) {
          const retryAfter = Math.ceil((lockout.lockedUntil - now) / 1000);
          c.header('Retry-After', String(retryAfter));
          return c.json({ error: 'too many tries', errorCode: 'LOCKED', retryAfter }, 429);
        }

        const parsed = founderSessionRequestSchema.safeParse(raw);
        if (!parsed.success) return c.json({ error: 'invalid request' }, 400);

        if (!passcodeMatches(f, parsed.data.passcode)) {
          lockout.failures += 1;
          if (lockout.failures >= MAX_ATTEMPTS) {
            lockout.failures = 0;
            lockout.lockedUntil = now + LOCKOUT_MS;
            log.warn('founder page locked after repeated wrong passcodes');
          }
          return c.json({ error: 'wrong passcode', errorCode: 'WRONG_PASSCODE' }, 401);
        }

        lockout.failures = 0;
        const token = issueFounderToken(f, now);
        const expiresAt = new Date(Number(token.split('.')[0])).toISOString();
        return c.json(founderSessionResponseSchema.parse({ token, expiresAt }));
      })

      // GET /api/founder/feedback: newest first, every family.
      .get('/feedback', async (c) => {
        const f = getSecrets();
        if (!f) return c.json({ error: 'not found' }, 404);
        const token = c.req.header('x-founder-token') ?? '';
        if (!verifyFounderToken(f, token)) {
          return c.json({ error: 'sign in again', errorCode: 'FOUNDER_TOKEN' }, 401);
        }

        const { rows: dbRows } = await getDb().execute<FeedbackDbRow>(
          sql`select * from app_founder_feedback(${FEEDBACK_LIMIT})`,
        );
        const rows = dbRows.map((r) => ({
          source: r.source,
          familySlug: r.family_slug,
          familyName: r.family_name,
          name: r.name,
          email: r.email,
          visitId: r.visit_id,
          screen: r.screen,
          features: r.features ?? [],
          pmfDisappointment: r.pmf_disappointment,
          recommendScore: r.recommend_score,
          solvesProblem: r.solves_problem,
          easeOfUse: r.ease_of_use,
          keepUsing: r.keep_using,
          painPoint: r.pain_point,
          featureRequest: r.feature_request,
          otherFeedback: r.other_feedback,
          createdAt: new Date(r.created_at).toISOString(),
        }));
        c.header('Cache-Control', 'no-store');
        return c.json(founderFeedbackResponseSchema.parse({ rows }));
      })
  );
}

const DEV_TOKEN_SECRET = 'dev-only-founder-token-secret-not-for-deployed-servers';

/** Both settings, or null (page off). Dev and test may use a built-in secret. */
export function founderSecretsFromConfig(): FounderSecrets | null {
  const passcode = config.FOUNDER_PASSCODE;
  const secret =
    config.FOUNDER_TOKEN_SECRET ??
    (config.NODE_ENV === 'production' ? undefined : DEV_TOKEN_SECRET);
  return passcode && secret ? { passcode, secret } : null;
}

export const founderRouter = createFounderRouter(founderSecretsFromConfig);
