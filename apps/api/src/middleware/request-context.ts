import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

// Per-request context stamped into every log line emitted during the
// request, plus echoed back via response headers so clients (and
// dashboards) can correlate.
//
// request_id: caller-provided X-Request-Id wins (allows distributed
// tracing across services); otherwise we mint a UUIDv4. The value is
// also written to the response so the client always learns the id even
// when they didn't supply one.
//
// tenant_id: PLACEHOLDER for FHS-178/179. Today we read X-Tenant-Id if
// the caller sets it, otherwise leave it undefined. Sprint 1 derives
// the real value from the JWT or subdomain (ADR 0002) and replaces this
// header-read with the AsyncLocalStorage tenant context (ADR 0001).

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
    tenantId: string | undefined;
  }
}

export function requestContext(): MiddlewareHandler {
  return async (c, next) => {
    const incoming = c.req.header('x-request-id')?.trim();
    const requestId = incoming && incoming.length <= 128 ? incoming : randomUUID();
    const tenantId = c.req.header('x-tenant-id')?.trim() || undefined;

    c.set('requestId', requestId);
    c.set('tenantId', tenantId);
    c.header('X-Request-Id', requestId);

    await next();
  };
}
