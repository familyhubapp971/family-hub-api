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
import { healthRouter } from './routes/health.js';
import { helloRouter } from './routes/hello.js';
import { meRouter } from './routes/me.js';
import { publicTenantRouter } from './routes/public-tenant.js';
import { slugAvailableRouter } from './routes/slug-available.js';
import { captureException } from './sentry.js';

const log = createLogger('app');

export interface BuildAppOptions {
  /** Test hook — passed straight through to authMiddleware. */
  auth?: AuthMiddlewareOptions;
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
