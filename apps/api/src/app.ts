import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { corsMiddleware } from './middleware/cors-allowlist.js';
import { rateLimit } from './middleware/rate-limit.js';
import { requestContext } from './middleware/request-context.js';
import { healthRouter } from './routes/health.js';
import { helloRouter } from './routes/hello.js';

const log = createLogger('app');

export function buildApp() {
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
      },
      'request',
    );
  });

  app.route('/health', healthRouter);
  app.route('/hello', helloRouter);

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => {
    log.error({ err }, 'unhandled error');
    return c.json({ error: 'internal server error' }, 500);
  });

  return app;
}

export const app = buildApp();
