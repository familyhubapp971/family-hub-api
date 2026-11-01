import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { swaggerUI } from '@hono/swagger-ui';
import { config } from './config.js';
import { buildOpenApiSpec } from './api-docs/build-spec.js';
import { createLogger } from './services/logger.js';
import { getDb } from './database/client.js';
import { getOrCreateUser } from './areas/family/user-mirror.js';
import { authMiddleware, type AuthMiddlewareOptions } from './security/auth.js';
import { rejectKidTokens } from './security/kid-auth.js';
import { corsMiddleware } from './security/cors-allowlist.js';
import { rateLimit } from './security/rate-limit.js';
import { GOTRUE_PREFIX, gotrueProxy } from './security/gotrue-proxy.js';
import { SignInLimits } from './security/signin-limits.js';
import { requestContext } from './services/request-context.js';
import { requestDb } from './security/request-db.js';
import {
  makeDbLookup,
  resolveTenant,
  type ResolveTenantOptions,
} from './security/resolve-tenant.js';
import { adminRouter } from './areas/admin/admin.js';
import { assignmentsRouter } from './areas/tasks/assignments.js';
import { kidPinRouter } from './areas/kids/auth-kid-pin.js';
import { dashboardRouter } from './areas/today/dashboard.js';
import { eventsRouter } from './areas/calendar/events.js';
import { habitsRouter } from './areas/tasks/habits.js';
import { mwWeeksRouter } from './areas/my-world/mw-weeks.js';
import { mwFinancialRouter } from './areas/my-world/mw-financial.js';
import { mwAnalyticsRouter } from './areas/my-world/mw-analytics.js';
import { rewardsRouter } from './areas/my-world/rewards.js';
import { mwRedemptionRequestsRouter } from './areas/my-world/mw-redemption-requests.js';
import { rewardConfigRouter } from './areas/my-world/reward-config.js';
import { journalRouter } from './areas/journal/journal.js';
import { healthRouter } from './areas/health/health.js';
import { helloRouter } from './areas/health/hello.js';
import {
  invitationClaimRouter,
  invitationResendRouter,
  invitationsRouter,
} from './areas/family/invitations.js';
import { kidRouter } from './areas/kids/kid.js';
import { meRouter } from './areas/family/me.js';
import { familyAddressRouter } from './areas/family/family-address.js';
import { mealsRouter } from './areas/meals/meals.js';
import { membersRouter } from './areas/family/members.js';
import { noticesRouter } from './areas/calendar/notices.js';
import { feedbackRouter } from './areas/feedback/feedback.js';
import { issueReportsRouter } from './areas/feedback/issue-reports.js';
import { learnInsightsRouter } from './areas/learn/learn-insights.js';
import { onboardingRouter } from './areas/family/onboarding.js';
import { tasksRouter } from './areas/tasks/tasks.js';
import { publicKidMembersRouter } from './areas/family/public-kid-members.js';
import { publicTenantRouter } from './areas/family/public-tenant.js';
import { publicFeedbackRouter } from './areas/feedback/public-feedback.js';
import { founderRouter } from './areas/admin/founder.js';
import { calendarRouter } from './areas/calendar/calendar.js';
import { publicCalendarRouter } from './areas/calendar/public-calendar.js';
import { captureException, captureMessage } from './services/sentry.js';

const log = createLogger('app');

// FHS-351: /api paths that legitimately run without a resolved tenant (pre-
// tenant signup, the user's own /me, kid routes scoped by the kid JWT, and the
// cross-tenant invite claim). The RLS observability warning skips these.
const TENANT_OPTIONAL_API_PREFIXES = [
  '/api/me',
  '/api/public/',
  '/api/auth/',
  '/api/kid',
  '/api/invitations/claim',
  '/api/founder/',
  '/api/family-address/',
];
function isTenantOptionalPath(path: string): boolean {
  return TENANT_OPTIONAL_API_PREFIXES.some((p) => path.startsWith(p));
}

// FHS-445: the public calendar feed carries its bearer credential IN the URL
// path (/api/public/calendar/<tenantId>.<sig>.ics). That secret must never
// reach logs or Sentry, so redact everything after the prefix before anything
// records the path. (logger.ts redaction only strips named fields, not a secret
// embedded inside a plain string value.)
const CALENDAR_FEED_PREFIX = '/api/public/calendar/';
function redactPath(path: string): string {
  return path.startsWith(CALENDAR_FEED_PREFIX) ? `${CALENDAR_FEED_PREFIX}[redacted]` : path;
}

export interface BuildAppOptions {
  /** Test hook: passed straight through to authMiddleware. */
  auth?: AuthMiddlewareOptions;
  /**
   * Test hook: passed to resolveTenant. Production wires
   * `lookupTenantId` to a real Drizzle query against the lazy DB pool.
   * Tests inject a stub so they don't need a live Postgres.
   */
  resolveTenant?: ResolveTenantOptions;
}

export function buildApp(opts: BuildAppOptions = {}) {
  const app = new Hono();

  // FHS-356: API docs, mounted FIRST so they bypass auth/tenant middleware and
  // the no-script CSP (Swagger UI needs to run JS). The spec is built lazily on
  // first request: by then every route below is mounted, so it covers them all.
  if (config.API_DOCS_ENABLED) {
    let cachedSpec: ReturnType<typeof buildOpenApiSpec> | null = null;
    app.get('/openapi.json', (c) => {
      cachedSpec ??= buildOpenApiSpec(app);
      return c.json(cachedSpec);
    });
    app.get('/docs', swaggerUI({ url: '/openapi.json' }));
  }

  // Security headers on every response. HSTS preload-eligible (1y +
  // includeSubDomains). CSP here is a defence-in-depth no-script policy
  // for any HTML the api accidentally returns; the web app's CSP lives
  // on its index.html meta tag.
  app.use(
    '*',
    secureHeaders({
      strictTransportSecurity: 'max-age=31536000; includeSubDomains; preload',
      xFrameOptions: 'DENY',
      xContentTypeOptions: 'nosniff',
      referrerPolicy: 'strict-origin-when-cross-origin',
      crossOriginOpenerPolicy: 'same-origin',
      crossOriginResourcePolicy: 'same-site',
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'none'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
      // Lock down powerful features by default; widen explicitly per route
      // when a feature genuinely needs them.
      permissionsPolicy: {
        camera: [],
        microphone: [],
        geolocation: [],
        payment: [],
      },
    }),
  );

  app.use('*', corsMiddleware());

  app.use('*', requestContext());

  app.use('*', rateLimit({ capacity: config.RATE_LIMIT_PER_MINUTE, windowMs: 60_000 }));

  // FHS-694: sign-in requests pass through to our private GoTrue server. Mounted
  // before the auth middleware, which would otherwise reject sign-in calls that
  // carry no token yet. ALL routes are left out of the OpenAPI spec: these are
  // GoTrue's endpoints, not ours.
  if (config.GOTRUE_URL) {
    const limits = new SignInLimits({
      maxFailedAttempts: config.SIGNIN_MAX_FAILED_ATTEMPTS,
      lockoutMs: config.SIGNIN_LOCKOUT_MS,
      emailsPerHour: config.SIGNIN_EMAILS_PER_HOUR,
    });
    app.all(
      `${GOTRUE_PREFIX}/*`,
      gotrueProxy(config.GOTRUE_URL, {
        limits,
        passwordSignInEmails: config.PASSWORD_SIGNIN_EMAILS,
      }),
    );
  }

  // Auth runs after request-context (so the 401 log line carries the
  // request id) but before any tenant-context resolution that keys off
  // the authenticated user. /health and /hello are public: handled
  // inside authMiddleware via PUBLIC_PATH_PREFIXES.
  // Default production wiring: bind the users-mirror sync to the lazy
  // DB pool. Tests pass opts.auth.userMirrorSync to inject a stub.
  const authOpts: AuthMiddlewareOptions = {
    userMirrorSync: (claims) => getOrCreateUser(getDb(), claims),
    ...(opts.auth ?? {}),
  };
  // FHS-257: reject a kid (HS256) token presented to a parent route with
  // an explicit 403 KID_ON_PARENT_ROUTE, before the parent ES256 auth
  // would 401 it. Skips /api/kid (where kid tokens belong) internally.
  app.use('*', rejectKidTokens);

  app.use('*', authMiddleware(authOpts));

  // Tenant resolution runs AFTER auth so the JWT-claim source can use
  // the verified payload. Public paths (kid-members, etc.) skipped
  // auth and therefore have no user; resolveTenant falls through to
  // subdomain / path-prefix sources, or leaves tenantId undefined.
  const resolveTenantOpts: ResolveTenantOptions = opts.resolveTenant ?? {
    lookupTenantId: makeDbLookup(getDb),
  };
  app.use('*', resolveTenant(resolveTenantOpts));

  // FHS-345: from here on, /api/* handlers run with a dedicated pooled DB
  // connection bound via AsyncLocalStorage (getDb() returns it). Mounted
  // after tenant resolution and scoped to /api/* so /health + /hello don't
  // needlessly check out a connection. FHS-346 pins the tenant GUC on it.
  app.use('/api/*', requestDb());

  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    const path = c.req.path;
    // Never log the raw calendar-feed path (it embeds the family's token).
    const logPath = redactPath(path);
    const tenantId = c.get('tenantId');
    const userId = c.get('user')?.id;
    log.info(
      {
        method: c.req.method,
        path: logPath,
        status: c.res.status,
        durationMs: Date.now() - started,
        request_id: c.get('requestId'),
        tenant_id: tenantId,
        user_id: userId,
      },
      'request',
    );
    // FHS-351: RLS observability. An authenticated /api/* request that ran with
    // NO tenant context, outside the tenant-optional set, is a signal that RLS
    // will fail closed (zero rows) once enforced. Surface it loudly (log +
    // Sentry) so a missing tenant shows up as a debuggable warning, not a silent
    // empty page. Best-effort: skip 5xx (already captured) and unauthenticated.
    if (
      userId &&
      !tenantId &&
      path.startsWith('/api/') &&
      c.res.status < 500 &&
      !isTenantOptionalPath(path)
    ) {
      log.warn(
        { method: c.req.method, path: logPath, request_id: c.get('requestId'), user_id: userId },
        'tenant-scoped request ran with no tenant context',
      );
      captureMessage('tenant-scoped request without tenant context', {
        path: logPath,
        method: c.req.method,
        requestId: c.get('requestId'),
        userId,
      });
    }
  });

  app.route('/health', healthRouter);
  app.route('/hello', helloRouter);
  app.route('/api/me', meRouter);
  app.route('/api/family-address', familyAddressRouter);
  app.route('/api/public/tenant', publicTenantRouter);
  app.route('/api/public/kid-members', publicKidMembersRouter);
  app.route('/api/public/feedback', publicFeedbackRouter);
  // FHS-672: founder feedback page; the passcode is the credential.
  app.route('/api/founder', founderRouter);
  // FHS-445: public calendar ICS feed (no auth; signed token in the URL).
  app.route('/api/public/calendar', publicCalendarRouter);
  app.route('/api/auth/kid-pin', kidPinRouter);
  // FHS-257: kid-scoped routes; skip parent auth (see PUBLIC_PATH_PREFIXES)
  // and verify the HS256 kid JWT inside the router instead.
  app.route('/api/kid', kidRouter);
  // FHS-275: claim must mount BEFORE the generic router so POST
  // /api/invitations/claim doesn't fall through to POST /api/invitations.
  app.route('/api/invitations/claim', invitationClaimRouter);
  // FHS-276: resend mounts on the same base path; its ':id/resend'
  // route shape doesn't collide with the create/list router.
  app.route('/api/invitations', invitationResendRouter);
  app.route('/api/invitations', invitationsRouter);
  app.route('/api/members', membersRouter);
  app.route('/api/dashboard', dashboardRouter);
  app.route('/api/meals', mealsRouter);
  app.route('/api/events', eventsRouter);
  app.route('/api/calendar', calendarRouter);
  app.route('/api/assignments', assignmentsRouter);
  app.route('/api/notices', noticesRouter);
  app.route('/api/tasks', tasksRouter);
  app.route('/api/habits', habitsRouter);
  app.route('/api/admin', adminRouter);
  app.route('/api/mw/weeks', mwWeeksRouter);
  app.route('/api/mw/financial', mwFinancialRouter);
  app.route('/api/mw/analytics', mwAnalyticsRouter);
  app.route('/api/mw/redemption-requests', mwRedemptionRequestsRouter);
  app.route('/api/rewards', rewardsRouter);
  app.route('/api/reward-config', rewardConfigRouter);
  app.route('/api/journal', journalRouter);
  // FHS-717: grown-ups report a problem with up to 3 photos.
  app.route('/api/feedback/issues', issueReportsRouter);
  app.route('/api/feedback', feedbackRouter);
  app.route('/api/learn/insights', learnInsightsRouter);
  app.route('/api/onboarding', onboardingRouter);

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => {
    log.error({ err }, 'unhandled error');
    captureException(err, {
      requestId: c.get('requestId'),
      tenantId: c.get('tenantId'),
      path: redactPath(c.req.path),
      method: c.req.method,
    });
    return c.json({ error: 'internal server error' }, 500);
  });

  return app;
}

export const app = buildApp();
