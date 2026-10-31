import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

// Per-request context: mints (or reuses) a request-id and seeds the
// tenant context vars to undefined. The real tenant resolution happens
// later in resolveTenant (FHS-13 + FHS-249) which sets tenantId/tenantSlug
// from JWT custom claim, subdomain, or `/t/<slug>/` path prefix.
//
// request_id: caller-provided X-Request-Id wins (allows distributed
// tracing across services); otherwise we mint a UUIDv4. The value is
// also written to the response so the client always learns the id.

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

    c.set('requestId', requestId);
    c.set('tenantId', undefined);
    c.header('X-Request-Id', requestId);

    await next();
  };
}
