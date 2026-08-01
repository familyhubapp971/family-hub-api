import { z } from 'zod';

// Exported for unit tests (config.test.ts) so the security-sensitive gates
// (e.g. E2E_TEST_JWKS must never be honoured outside NODE_ENV=test) can be
// asserted against a synthetic env without touching the real process.env.
export const configSchema = z
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
    // FHS-356 — serve the OpenAPI spec (/openapi.json) + Swagger UI (/docs).
    // Secure-by-default: OFF in production, ON elsewhere (dev/test/staging),
    // unless API_DOCS_ENABLED is set explicitly. The derived default lives in
    // the final transform below.
    API_DOCS_ENABLED: z
      .string()
      .optional()
      .transform((v) =>
        v === undefined ? undefined : ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase()),
      ),
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
    // FHS-445 — the API's own public origin (e.g. https://api.fhapp.co), used to
    // build the absolute calendar subscribe URL. When set it is trusted over the
    // request Host header (which a client can spoof); unset, we fall back to the
    // request origin so dev + tests work without configuration.
    API_PUBLIC_URL: z.string().url().optional(),
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
    // FHS-389 — AI-generated Maths lessons (Anthropic Claude Haiku).
    // Feature flag: OFF by default. Set LEARN_AI_ENABLED=true AND supply
    // ANTHROPIC_API_KEY for live AI. When the flag is off (or the key is
    // empty) the endpoint returns { enabled: false } — the static Maths
    // bank remains the full experience. Never commit a real key.
    // NB: z.coerce.boolean() treats any non-empty string (incl. "false") as
    // true, so parse the env string explicitly — only "true"/"1" enable it.
    LEARN_AI_ENABLED: z
      .string()
      .default('false')
      .transform((v) => v === 'true' || v === '1'),
    ANTHROPIC_API_KEY: z.string().default(''),
    // FHS-445 — server-side secret that signs the calendar "subscribe link"
    // tokens (HMAC). Required in production; dev/test tolerate a default so the
    // api boots without the operator generating a secret first. Same posture as
    // KID_AUTH_SECRET.
    CALENDAR_FEED_SECRET: z
      .string()
      .min(32, 'CALENDAR_FEED_SECRET must be at least 32 characters')
      .default('dev-only-calendar-feed-secret-replace-in-production'),
    // FHS-510 — Resend (email-sending service), used for the admin-initiated
    // sign-in email change confirmation link. Empty key = the sender logs and
    // returns an error instead of crashing boot (routes/members.ts handles
    // that gracefully with a 502).
    RESEND_API_KEY: z.string().default(''),
    RESEND_FROM_EMAIL: z.string().default('noreply@fhapp.co'),
    RESEND_FROM_NAME: z.string().default('FamilyHub'),
    // FHS-516 — E2E auth harness. The Playwright E2E tier runs the api as a
    // separate HTTP process (unlike the integration tier, which injects a
    // test JWKS in-process via AuthMiddlewareOptions), so it has no way to
    // make the running api trust test-minted JWTs — until now. When this is
    // set, it's a JSON-encoded JWKS (`{"keys":[...]}`) containing ONLY
    // public key material; middleware/auth.ts trusts it INSTEAD OF fetching
    // Supabase's real JWKS, so Playwright specs can mint their own valid
    // ES256 tokens locally (see tests/e2e/support/auth/) without a real
    // Supabase login round trip. Verification still requires ES256 + the
    // matching issuer — this only swaps where the trusted keys come from.
    //
    // Optional and unset by default, so every existing deploy (and every
    // deploy that doesn't opt in) behaves exactly as before. The superRefine
    // guard below additionally REFUSES TO BOOT if this is ever set with
    // Belt-and-suspenders on top of the middleware's own `NODE_ENV === 'test'`
    // activation check (auth.ts): the superRefine below refuses to boot ANY
    // non-test process (development, staging, production) that has this var
    // set, so neither a stray env var on a real deploy nor a developer's
    // exported shell var under `pnpm dev` can downgrade real auth. Set only by
    // tests/e2e/playwright*.config.ts's webServer env (which forces NODE_ENV=test).
    E2E_TEST_JWKS: z.string().optional(),
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
    if (
      cfg.NODE_ENV === 'production' &&
      cfg.CALENDAR_FEED_SECRET === 'dev-only-calendar-feed-secret-replace-in-production'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CALENDAR_FEED_SECRET'],
        message: 'CALENDAR_FEED_SECRET must be a real secret in production (FHS-445).',
      });
    }
    if (cfg.NODE_ENV !== 'test' && cfg.E2E_TEST_JWKS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['E2E_TEST_JWKS'],
        message:
          'E2E_TEST_JWKS must never be set outside NODE_ENV=test (FHS-516) — it would let ' +
          'anyone holding the (public) e2e test key sign in as any user. Only the e2e ' +
          'harness (which forces NODE_ENV=test) may set it. Unset it on this process.',
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
    // FHS-356 — docs off in production by default; on in dev/test/staging.
    // Staging explicitly sets API_DOCS_ENABLED=true so it shows even if it runs
    // with NODE_ENV=production.
    API_DOCS_ENABLED: cfg.API_DOCS_ENABLED ?? cfg.NODE_ENV !== 'production',
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
