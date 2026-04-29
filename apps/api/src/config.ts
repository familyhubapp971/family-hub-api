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
    // Sentry — empty DSN = silent no-op, fine for dev / when account
    // not yet provisioned. SENTRY_RELEASE is the git SHA, set by CI/Railway.
    SENTRY_DSN_API: z.string().default(''),
    SENTRY_RELEASE: z.string().default(''),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
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
