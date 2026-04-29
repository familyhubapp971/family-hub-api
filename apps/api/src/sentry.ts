import * as Sentry from '@sentry/node';
import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('sentry');

// Initialise as early as possible — must run before any error-catching
// code paths. import './sentry.js' from index.ts BEFORE './app.js'.
//
// Empty DSN = silent no-op (dev, or before the Sentry project is
// provisioned). All Sentry.* calls remain safe in this state.
//
// tenant_id placeholder: every event gets `tenant_id: null` for now.
// Sprint 1 wires the real value from AsyncLocalStorage (ADR 0001) via
// a beforeSend hook that reads from the request context.
export function initSentry(): void {
  if (!config.SENTRY_DSN_API) {
    log.info('SENTRY_DSN_API not set — Sentry disabled (no-op)');
    return;
  }

  Sentry.init({
    dsn: config.SENTRY_DSN_API,
    environment: config.NODE_ENV,
    ...(config.SENTRY_RELEASE ? { release: config.SENTRY_RELEASE } : {}),
    tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
    // Strip PII at the edge — defence in depth alongside the pino redact list.
    sendDefaultPii: false,
    initialScope: {
      tags: {
        tenant_id: 'null', // placeholder — Sprint 1 sets per-request via beforeSend
        service: '@familyhub/api',
      },
    },
  });

  log.info(
    {
      release: config.SENTRY_RELEASE || '(unset)',
      tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
    },
    'Sentry initialised',
  );
}

/** Called from the Hono onError handler so unhandled errors surface in Sentry. */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!config.SENTRY_DSN_API) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}
