// FHS-717: the issue report form opens its own short connections, so the
// per-request connection must not be taken for it (a slow photo upload would
// hold it for the whole upload). Every other /api request still gets one.
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { managesOwnConnection, requestDb } from '../../../../src/security/request-db.js';

const runWithRequestDb = vi.fn(async (fn: () => Promise<unknown>) => fn());
vi.mock('../../../../src/database/client.js', () => ({
  runWithRequestDb: (fn: () => Promise<unknown>, opts: unknown) => runWithRequestDb(fn, opts),
}));

function buildApp() {
  const app = new Hono();
  app.use('/api/*', requestDb());
  app.all('/api/*', (c) => c.text('ok'));
  return app;
}

describe('requestDb', () => {
  beforeEach(() => {
    runWithRequestDb.mockClear();
  });

  it('takes no connection for the issue report form', async () => {
    const res = await buildApp().request('/api/feedback/issues', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(runWithRequestDb).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', '/api/feedback'],
    ['GET', '/api/feedback/issues'],
    ['GET', '/api/founder/issues'],
  ])('still takes one for %s %s', async (method, path) => {
    await buildApp().request(path, { method });
    expect(runWithRequestDb).toHaveBeenCalledTimes(1);
  });

  it('names exactly the one route', () => {
    expect(managesOwnConnection('POST', '/api/feedback/issues')).toBe(true);
    expect(managesOwnConnection('PATCH', '/api/feedback/issues')).toBe(false);
  });
});
