// Sentry MUST initialise before app.js imports anything that might throw:
// the SDK patches global handlers at init time.
import { initSentry } from './sentry.js';
initSentry();

import { serve } from '@hono/node-server';
import { app } from './app.js';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { assertRlsEnforceable } from './lib/rls-boot-guard.js';

const log = createLogger('server');

async function main() {
  // FHS-351: when RLS enforcement is expected, refuse to boot if the connected
  // DB role can bypass RLS. Off by default (pre-flip owner-role deploys boot
  // normally); the founder sets RLS_ENFORCED=true in the app_runtime flip deploy.
  if (config.RLS_ENFORCED) {
    try {
      await assertRlsEnforceable();
      log.info('RLS boot guard passed: connected role cannot bypass RLS');
    } catch (err) {
      log.fatal({ err }, 'RLS boot guard failed: refusing to start');
      process.exit(1);
    }
  }

  const server = serve({
    fetch: app.fetch,
    port: config.PORT,
  });

  log.info({ port: config.PORT, env: config.NODE_ENV }, 'api server listening');

  const shutdown = (signal: string) => {
    log.info({ signal }, 'shutting down');
    // Force-exit if graceful close hangs (owned by FHS-167 for full refinement).
    setTimeout(() => {
      log.error({ signal }, 'forced exit after 10s graceful timeout');
      process.exit(1);
    }, 10_000).unref();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
