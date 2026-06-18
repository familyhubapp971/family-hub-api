import type { MiddlewareHandler } from 'hono';
import { runWithRequestDb } from '../db/client.js';

// FHS-345 — wrap each API request in a dedicated pooled DB connection bound
// via AsyncLocalStorage, so every `getDb()` in the request's async call tree
// returns the SAME connection. This is the foundation for per-request RLS:
// FHS-346 will pin `app.current_tenant` on that one connection. The
// connection is always released when the request finishes (success or error).
export function requestDb(): MiddlewareHandler {
  return async (_c, next) => {
    await runWithRequestDb(() => next());
  };
}
