import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { getDb } from './db/client.js';
import { getOrCreateUser } from './lib/user-mirror.js';
import { authMiddleware, type AuthMiddlewareOptions } from './middleware/auth.js';
import { corsMiddleware } from './middleware/cors-allowlist.js';
import { rateLimit } from './middleware/rate-limit.js';
import { requestContext } from './middleware/request-context.js';
import {
  makeDbLookup,
  resolveTenant,
  type ResolveTenantOptions,
} from './middleware/resolve-tenant.js';
import { dashboardRouter } from './routes/dashboard.js';
import { eventsRouter } from './routes/events.js';
import { healthRouter } from './routes/health.js';
import { helloRouter } from './routes/hello.js';
import { invitationsRouter } from './routes/invitations.js';
import { meRouter } from './routes/me.js';
import { mealsRouter } from './routes/meals.js';
import { membersRouter } from './routes/members.js';
import { onboardingRouter } from './routes/onboarding.js';
import { publicTenantRouter } from './routes/public-tenant.js';
import { slugAvailableRouter } from './routes/slug-available.js';
import { captureException } from './sentry.js';

const log = createLogger('app');

export interface BuildAppOptions {
  /** Test hook — passed straight through to authMiddleware. */
  auth?: AuthMiddlewareOptions;
  /**
   * Test hook — passed to resolveTenant. Production wires
   * `lookupTenantId` to a real Drizzle query against the lazy DB pool.
   * Tests inject a stub so they don't need a live Postgres.
   */
  resolveTenant?: ResolveTenantOptions;
}

export function buildApp(opts: BuildAppOptions = {}) {
  const app = new Hono();

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

  // Auth runs after request-context (so the 401 log line carries the
  // request id) but before any tenant-context resolution that keys off
  // the authenticated user. /health and /hello are public — handled
  // inside authMiddleware via PUBLIC_PATH_PREFIXES.
  // Default production wiring: bind the users-mirror sync to the lazy
  // DB pool. Tests pass opts.auth.userMirrorSync to inject a stub.
  const authOpts: AuthMiddlewareOptions = {
    userMirrorSync: (claims) => getOrCreateUser(getDb(), claims),
    ...(opts.auth ?? {}),
  };
  app.use('*', authMiddleware(authOpts));

  // Tenant resolution runs AFTER auth so the JWT-claim source can use
  // the verified payload. Public paths (slug-available, etc.) skipped
  // auth and therefore have no user; resolveTenant falls through to
  // subdomain / path-prefix sources, or leaves tenantId undefined.
  const resolveTenantOpts: ResolveTenantOptions = opts.resolveTenant ?? {
    lookupTenantId: makeDbLookup(getDb()),
  };
  app.use('*', resolveTenant(resolveTenantOpts));

  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    log.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - started,
        request_id: c.get('requestId'),
        tenant_id: c.get('tenantId'),
        user_id: c.get('user')?.id,
      },
      'request',
    );
  });

  app.route('/health', healthRouter);
  app.route('/hello', helloRouter);
  app.route('/api/me', meRouter);
  app.route('/api/public/tenant', publicTenantRouter);
  app.route('/api/public/slug-available', slugAvailableRouter);
  app.route('/api/invitations', invitationsRouter);
  app.route('/api/members', membersRouter);
  app.route('/api/dashboard', dashboardRouter);
  app.route('/api/meals', mealsRouter);
  app.route('/api/events', eventsRouter);
  app.route('/api/onboarding', onboardingRouter);

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => {
    log.error({ err }, 'unhandled error');
    captureException(err, {
      requestId: c.get('requestId'),
      tenantId: c.get('tenantId'),
      path: c.req.path,
      method: c.req.method,
    });
    return c.json({ error: 'internal server error' }, 500);
  });

  return app;
}

export const app = buildApp();
