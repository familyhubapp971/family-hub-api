import { Hono } from 'hono';
import { createLogger } from './logger.js';
import { healthRouter } from './routes/health.js';
import { helloRouter } from './routes/hello.js';

const log = createLogger('app');

export function buildApp() {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    log.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - started,
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
