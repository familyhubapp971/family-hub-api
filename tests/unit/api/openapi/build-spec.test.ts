import { describe, it, expect } from 'vitest';
import { buildApp } from '../../../../apps/api/src/app.js';
import { buildOpenApiSpec } from '../../../../apps/api/src/openapi/build-spec.js';

// FHS-356: the OpenAPI spec is generated from the live Hono route table, so
// these tests lock the contract: every endpoint is covered, the docs routes are
// excluded, auth vs public is marked correctly, and the documented endpoints
// carry their real request/response schemas.

const app = buildApp();
const spec = buildOpenApiSpec(app);

function operationCount(s: typeof spec): number {
  return Object.values(s.paths).reduce(
    (n, ops) =>
      n +
      Object.keys(ops).filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).length,
    0,
  );
}

describe('FHS-356: OpenAPI spec from the live route table', () => {
  it('is a valid OpenAPI 3.0 document with info + bearer scheme', () => {
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info['title']).toBe('Family Hub API');
    expect(
      (spec.components['securitySchemes'] as Record<string, unknown>)['bearerAuth'],
    ).toBeTruthy();
  });

  it('covers every real endpoint and excludes the docs meta-routes', () => {
    // One operation per real HTTP route the app mounts (sanity floor).
    expect(operationCount(spec)).toBeGreaterThanOrEqual(80);
    expect(spec.paths['/openapi.json']).toBeUndefined();
    expect(spec.paths['/docs']).toBeUndefined();
  });

  it('marks public/auth routes without bearer auth and tenant routes with it', () => {
    expect(spec.paths['/api/public/slug-available']?.['get']).not.toHaveProperty('security');
    expect(spec.paths['/api/auth/kid-pin']?.['post']).not.toHaveProperty('security');
    // FHS-666: creating a family needs the new parent's sign-in, despite the /public path.
    expect(
      (spec.paths['/api/public/tenant']?.['post'] as Record<string, unknown>)['security'],
    ).toEqual([{ bearerAuth: [] }]);
    expect((spec.paths['/api/members']?.['get'] as Record<string, unknown>)['security']).toEqual([
      { bearerAuth: [] },
    ]);
    // /api/kid/* use the kid PIN token, not the Supabase JWT.
    expect((spec.paths['/api/kid/today']?.['get'] as Record<string, unknown>)['security']).toEqual([
      { kidAuth: [] },
    ]);
  });

  it('attaches the real request + response schemas on documented endpoints', () => {
    const me = spec.paths['/api/me']?.['get'] as Record<string, unknown>;
    const meResp = (me['responses'] as Record<string, Record<string, unknown>>)['200'];
    expect(meResp['content']).toBeTruthy();

    const createTenant = spec.paths['/api/public/tenant']?.['post'] as Record<string, unknown>;
    expect(createTenant['requestBody']).toBeTruthy();
  });

  it('declares path parameters for routes with :params', () => {
    const setPin = spec.paths['/api/members/{id}/pin']?.['put'] as Record<string, unknown>;
    expect(setPin['parameters']).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      expect.objectContaining({ name: 'x-tenant-slug', in: 'header', required: false }),
    ]);
  });

  it('FHS-664: documents the family header on adult routes but not kid or public ones', () => {
    const names = (path: string, method: string) =>
      (
        ((spec.paths[path]?.[method] as Record<string, unknown>)['parameters'] ?? []) as Array<{
          name: string;
        }>
      ).map((p) => p.name);
    expect(names('/api/tasks', 'get')).toContain('x-tenant-slug');
    expect(names('/api/kid/me', 'get')).not.toContain('x-tenant-slug');
    expect(names('/api/public/slug-available', 'get')).not.toContain('x-tenant-slug');
  });

  it('FHS-664: documents real status codes and non-JSON replies', () => {
    const responses = (path: string, method: string) =>
      Object.keys((spec.paths[path]?.[method] as Record<string, unknown>)['responses'] as object);
    expect(responses('/api/tasks', 'post')).toEqual(['201']);
    expect(responses('/api/rewards/{id}', 'delete')).toEqual(['204']);
    const ics = (spec.paths['/api/public/calendar/{token}']?.['get'] as Record<string, any>)
      .responses['200'].content;
    expect(Object.keys(ics)).toEqual(['text/calendar']);
  });
});

describe('FHS-356: docs are served', () => {
  it('serves the spec at GET /openapi.json', async () => {
    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(body.openapi).toBe('3.0.3');
    expect(Object.keys(body.paths).length).toBeGreaterThan(0);
  });

  it('serves Swagger UI at GET /docs', async () => {
    const res = await app.request('/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});
