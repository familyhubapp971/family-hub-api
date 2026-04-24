import { serve } from '@hono/node-server';
import { app } from './app.js';
import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('server');

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
