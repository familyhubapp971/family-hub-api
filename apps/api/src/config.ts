import { z } from 'zod';

const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3001),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z.string().url().optional(),
    // Cookie domain root + CORS allowlist root + tenant-slug subdomain
    // (ADR 0002). localhost in dev; familyhub.app in prod.
    BASE_DOMAIN: z.string().default('localhost'),
    // Comma-separated explicit allowlist override; when empty the CORS
    // middleware derives http+https variants of BASE_DOMAIN and any
    // subdomain.
    CORS_ALLOWED_ORIGINS: z.string().default(''),
    // Token bucket: requests per minute per IP. Set 0 to disable (tests).
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().nonnegative().default(100),
    // FHS-351 — when true, the app refuses to boot unless the connected DB role
    // CANNOT bypass RLS (i.e. it's the non-privileged app_runtime role, not the
    // owner/superuser). Default off so the pre-flip owner-role deploy keeps
    // booting; set true in the same deploy that points DATABASE_URL at
    // app_runtime (the session-mode pooler port). Case-insensitive truthy
    // (true/1/yes/on) so an operator typing "TRUE" can't silently leave this
    // security flag off on the exact deploy that needs it.
    RLS_ENFORCED: z
      .string()
      .default('false')
      .transform((v) => ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())),
    // Sentry — empty DSN = silent no-op, fine for dev / when account
    // not yet provisioned. SENTRY_RELEASE is the git SHA, set by CI/Railway.
    SENTRY_DSN_API: z.string().default(''),
    SENTRY_RELEASE: z.string().default(''),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
    // Supabase — auth middleware (FHS-191) verifies JWTs against the
    // project JWKS at <SUPABASE_URL>/auth/v1/.well-known/jwks.json.
    // Required in production; empty in dev/test means the middleware
    // rejects every protected request (fail-closed) until configured.
    SUPABASE_URL: z.string().url().optional(),
    // Service-role key — required by routes that call Supabase admin
    // APIs (e.g. POST /api/invitations → admin.inviteUserByEmail in
    // FHS-91). Optional in dev so health/hello stay bootable without
    // it, but routes that need it fail loudly when it's missing.
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
    // Public origin where the SPA serves the auth callback (e.g.
    // https://frontend-staging-409d.up.railway.app). Used to build the
    // redirectTo URL on Supabase admin invites — the invitee clicks
    // the email link and lands on <APP_BASE_URL>/auth/callback.
    APP_BASE_URL: z.string().url().optional(),
    // Cache TTL for the JWKS in milliseconds. 10 minutes by default —
    // long enough to amortise network cost, short enough that a key
    // rotation propagates without an api restart.
    JWKS_CACHE_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 60_000),
    // FHS-236 — server-side secret used to sign / verify the
    // child-scoped JWT issued by POST /api/auth/kid-pin. Required in
    // production; in dev/test we tolerate a default so the api boots
    // without the operator having generated a secret first.
    KID_AUTH_SECRET: z
      .string()
      .min(32, 'KID_AUTH_SECRET must be at least 32 characters')
      .default('dev-only-kid-auth-secret-replace-in-production'),
    // Number of consecutive failed PINs before the (memberId, ip)
    // bucket is locked out for KID_PIN_LOCKOUT_MS. Token bucket lives
    // in process memory for v1 — replace with Redis once we have
    // multi-replica api hosts.
    KID_PIN_LOCKOUT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    KID_PIN_LOCKOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60_000),
    // Lifetime of a successful kid JWT. Short by default — kids stay
    // signed in long enough for a session of homework / meal-planning
    // but the token expires before bedtime so an unattended device
    // doesn't keep working overnight.
    KID_JWT_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60 * 60_000),
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.DATABASE_URL) {
      if (cfg.NODE_ENV === 'production') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DATABASE_URL'],
          message: 'DATABASE_URL is required in production (no localhost fallback permitted)',
        });
      }
    }
    if (!cfg.SUPABASE_URL && cfg.NODE_ENV === 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUPABASE_URL'],
        message: 'SUPABASE_URL is required in production for JWT verification (FHS-191).',
      });
    }
    if (
      cfg.NODE_ENV === 'production' &&
      cfg.KID_AUTH_SECRET === 'dev-only-kid-auth-secret-replace-in-production'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['KID_AUTH_SECRET'],
        message: 'KID_AUTH_SECRET must be a real secret in production (FHS-236).',
      });
    }
  })
  .transform((cfg) => ({
    ...cfg,
    DATABASE_URL:
      cfg.DATABASE_URL ??
      (cfg.NODE_ENV === 'production'
        ? (() => {
            throw new Error('unreachable: production DATABASE_URL checked in superRefine');
          })()
        : 'postgres://localhost:5432/familyhub_dev'),
  }));

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config = loadConfig();
