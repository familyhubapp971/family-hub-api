import type { MiddlewareHandler } from 'hono';
import { runWithRequestDb } from '../database/client.js';

// FHS-345/346: wrap each API request in a dedicated pooled DB connection
// bound via AsyncLocalStorage, with the resolved tenant pinned on it via
// `app.current_tenant` (set_config). Every `getDb()` in the request's async
// call tree returns that SAME connection, so RLS policies (FHS-348) see the
// right tenant without touching any of the ~69 call sites. The connection is
// always released, and the tenant GUC always reset, when the request
// finishes (success or error).
//
// Mounted AFTER resolveTenant, so c.var.tenantId is populated here. Public /
// tenant-less requests pass undefined → the empty sentinel (never stale).
//
// FHS-717: a route listed here opens its own short connections instead. The
// issue report form can carry 3.5 MB of photos from a slow phone, and holding
// one of the pool's 10 connections for the whole upload would let a few slow
// uploads stall every family.
const OWN_CONNECTION_ROUTES = new Set(['POST /api/feedback/issues']);

export function managesOwnConnection(method: string, path: string): boolean {
  return OWN_CONNECTION_ROUTES.has(`${method} ${path}`);
}

export function requestDb(): MiddlewareHandler {
  return async (c, next) => {
    if (managesOwnConnection(c.req.method, c.req.path)) {
      await next();
      return;
    }
    await runWithRequestDb(() => next(), { tenantId: c.get('tenantId') });
  };
}
