import type { Hono } from 'hono';

// Hono app.request() wrapper with sensible defaults for integration
// tests. Resolves the tenant the SAME way prod does (per ADR 0002):
// subdomain via the Host header — `<tenantSlug>.familyhub.app`. Setting
// only `x-tenant-id` would silently fail because the tenant middleware
// reads from the subdomain.
//
// Pass `tenantSlug: 'acme'` (the slug, not the UUID) and the helper
// builds an absolute URL with the right Host.

export interface MakeRequestOptions {
  body?: unknown;
  tenantSlug?: string;
  headers?: Record<string, string>;
}

const TEST_HOST_BASE = 'familyhub.app';

export async function makeRequest(
  app: Hono,
  method: string,
  path: string,
  opts: MakeRequestOptions = {},
): Promise<Response> {
  const url = opts.tenantSlug
    ? `http://${opts.tenantSlug}.${TEST_HOST_BASE}${path}`
    : path;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...opts.headers,
  };

  return app.request(url, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}
