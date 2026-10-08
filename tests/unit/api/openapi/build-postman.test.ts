import { describe, it, expect } from 'vitest';
import { buildApp } from '../../../../apps/api/src/app.js';
import { buildOpenApiSpec, findUndocumented } from '../../../../apps/api/src/openapi/build-spec.js';
import {
  buildPostmanCollection,
  buildPostmanFiles,
  sampleFor,
} from '../../../../apps/api/src/openapi/build-postman.js';

// FHS-664: the Postman collection is built from the OpenAPI spec, so these
// tests lock what a tester relies on: one request per endpoint, the right
// sign-in on each, the family header, and environments listing every variable.

const spec = buildOpenApiSpec(buildApp());
const collection = buildPostmanCollection(spec) as {
  item: Array<{ name: string; item: Array<Record<string, any>> }>;
};
const requests = collection.item.flatMap((f) => f.item);

function find(method: string, raw: string) {
  return requests.find((r) => r.request.method === method && r.request.url.raw === raw);
}

describe('FHS-664: Postman collection from the OpenAPI spec', () => {
  it('has one request per documented endpoint', () => {
    const ops = Object.values(spec.paths).reduce(
      (n, ops) =>
        n +
        Object.keys(ops).filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
          .length,
      0,
    );
    // Plus the 3 Supabase sign-in requests, which are not part of our API.
    expect(requests).toHaveLength(ops + 3);
  });

  it('uses the parent token, the kid token, or no auth as the spec says', () => {
    expect(find('GET', '{{baseUrl}}/api/me')?.request.auth.bearer[0].value).toBe('{{userToken}}');
    expect(find('GET', '{{baseUrl}}/api/kid/me')?.request.auth.bearer[0].value).toBe(
      '{{kidToken}}',
    );
    expect(find('GET', '{{baseUrl}}/health')?.request.auth.type).toBe('noauth');
  });

  it('sends the family header on adult routes only', () => {
    const header = (r: any) => r.request.header.map((h: any) => h.key);
    expect(header(find('GET', '{{baseUrl}}/api/tasks'))).toContain('x-tenant-slug');
    expect(header(find('GET', '{{baseUrl}}/api/kid/me'))).not.toContain('x-tenant-slug');
  });

  it('FHS-666: names requests by path and orders folders by the tester journey', () => {
    expect(find('GET', '{{baseUrl}}/api/tasks')?.name).toBe('/api/tasks');
    expect(collection.item[0]?.name).toBe('00 Health checks');
    expect(collection.item[1]?.name).toBe('01 Parent sign-in and sign-up (Supabase)');
  });

  it('FHS-666: verifying the email link saves the parent token', () => {
    const verify = collection.item[1]?.item.find((r) => r.name === 'Verify email link');
    const scripts = verify?.event.map((e: any) => e.script.exec.join('\n')).join('\n');
    expect(scripts).toContain("pm.environment.set('userToken'");
    expect(scripts).toContain("pm.environment.set('emailTokenHash'");
  });

  it('FHS-666: keeps the Supabase key blank unless the local copy fills it', () => {
    const blank = JSON.parse(buildPostmanFiles(spec)['staging.postman_environment.json'] as string);
    const filled = JSON.parse(
      buildPostmanFiles(spec, { supabaseAnonKey: 'k' })[
        'staging.postman_environment.json'
      ] as string,
    );
    const key = (env: any) => env.values.find((v: any) => v.key === 'supabaseAnonKey').value;
    expect(key(blank)).toBe('');
    expect(key(filled)).toBe('k');
  });

  it('saves the kid token after a kid PIN sign-in', () => {
    const kidPin = find('POST', '{{baseUrl}}/api/auth/kid-pin');
    expect(kidPin?.event[0].script.exec.join('\n')).toContain("pm.environment.set('kidToken'");
  });

  it('names path variables after the record they point at', () => {
    const del = find('DELETE', '{{baseUrl}}/api/tasks/:id');
    expect(del?.request.url.variable).toEqual([{ key: 'id', value: '{{taskId}}' }]);
  });

  it('writes local and staging environments that list every variable used', () => {
    const files = buildPostmanFiles(spec);
    const staging = JSON.parse(files['staging.postman_environment.json'] as string);
    const keys = staging.values.map((v: any) => v.key);
    for (const m of (files['family-hub-api.postman_collection.json'] as string).matchAll(
      /\{\{([A-Za-z0-9_]+)\}\}/g,
    )) {
      expect(keys).toContain(m[1]);
    }
    expect(staging.values.find((v: any) => v.key === 'userToken').type).toBe('secret');
  });

  it('builds a sample body that respects formats and required fields', () => {
    expect(
      sampleFor({
        type: 'object',
        required: ['id', 'when'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          when: { type: 'string', format: 'date' },
          note: { type: 'string' },
        },
      }),
    ).toEqual({ id: '00000000-0000-4000-8000-000000000000', when: '2099-01-01' });
  });
});

describe('FHS-664: every endpoint is fully documented', () => {
  it('leaves no route without a summary, reply and request shape', () => {
    expect(findUndocumented(buildApp())).toEqual([]);
  });
});
