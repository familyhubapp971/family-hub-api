import type { MiddlewareHandler } from 'hono';
import { runWithRequestDb } from '../db/client.js';

// FHS-345/346 — wrap each API request in a dedicated pooled DB connection
// bound via AsyncLocalStorage, with the resolved tenant pinned on it via
// `app.current_tenant` (set_config). Every `getDb()` in the request's async
// call tree returns that SAME connection, so RLS policies (FHS-348) see the
// right tenant without touching any of the ~69 call sites. The connection is
// always released — and the tenant GUC always reset — when the request
// finishes (success or error).
//
// Mounted AFTER resolveTenant, so c.var.tenantId is populated here. Public /
// tenant-less requests pass undefined → the empty sentinel (never stale).
export function requestDb(): MiddlewareHandler {
  return async (c, next) => {
    await runWithRequestDb(() => next(), { tenantId: c.get('tenantId') });
  };
}
