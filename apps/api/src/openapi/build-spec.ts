// FHS-356: build the OpenAPI 3.0 spec from the LIVE Hono route table.
//
// We enumerate `app.routes` rather than hand-listing endpoints, so every
// mounted route is documented automatically and a new/removed route shows up
// in the regenerated spec with zero manual bookkeeping (the CI staleness gate
// then forces the committed spec to match). The registry adds request/response
// detail on top via the handlers' own Zod schemas.

import type { Hono } from 'hono';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { isPublicPath } from '../middleware/auth.js';
import { routeMeta } from './registry.js';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

// The docs meta-routes themselves aren't part of the API contract.
const EXCLUDED_PATHS = new Set(['/openapi.json', '/docs']);

const VERB_WORD: Record<HttpMethod, string> = {
  GET: 'Get',
  POST: 'Create',
  PUT: 'Replace',
  PATCH: 'Update',
  DELETE: 'Delete',
};

/** Hono `:param` → OpenAPI `{param}`. */
function toOpenApiPath(honoPath: string): string {
  return honoPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function pathParamNames(openApiPath: string): string[] {
  return [...openApiPath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string);
}

function tagFor(path: string): string {
  if (path === '/health' || path === '/hello') return 'system';
  if (path.startsWith('/api/auth')) return 'auth';
  // Creating a family is a signed-in setup step, not a public page.
  if (path === '/api/public/tenant') return 'onboarding';
  if (path.startsWith('/api/public')) return 'public';
  if (path.startsWith('/api/kid')) return 'kid';
  if (path === '/api/me') return 'me';
  if (path.startsWith('/api/mw/')) return 'my-world';
  const m = path.match(/^\/api\/([^/]+)/);
  return m ? (m[1] as string) : 'other';
}

function jsonSchema(schema: Parameters<typeof zodToJsonSchema>[0]): unknown {
  // openApi3 target keeps it OpenAPI-3.0 compatible; inline (no $ref) so each
  // operation is self-contained and easy to read in Swagger UI.
  const s = zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' }) as Record<
    string,
    unknown
  >;
  delete s['$schema'];
  return s;
}

// FHS-666: "needs no sign-in" comes from the auth middleware's own list, so
// the docs cannot disagree with the server. /api/kid uses the kid token instead.
function isPublicRoute(oaPath: string): boolean {
  return !oaPath.startsWith('/api/kid') && isPublicPath(oaPath);
}

/**
 * FHS-664: every mounted route must carry a complete registry entry: a real
 * summary, a reply (a response schema, status 204, or a non-JSON
 * responseContentType), and for POST/PUT/PATCH
 * a request schema unless it is marked `bodyless`. Returns the gaps.
 */
export function findUndocumented(app: Pick<Hono, 'routes'>): string[] {
  const gaps = new Set<string>();
  for (const r of app.routes) {
    if (!(HTTP_METHODS as readonly string[]).includes(r.method) || EXCLUDED_PATHS.has(r.path)) {
      continue;
    }
    const key = `${r.method} ${toOpenApiPath(r.path)}`;
    const meta = routeMeta[key];
    const missing: string[] = [];
    if (!meta?.summary) missing.push('summary');
    if (!meta?.response && meta?.status !== 204 && !meta?.responseContentType) {
      missing.push('response (or status 204, or responseContentType)');
    }
    if (['POST', 'PUT', 'PATCH'].includes(r.method) && !meta?.request && !meta?.bodyless) {
      missing.push('request (or bodyless: true)');
    }
    if (missing.length) gaps.add(`${key}: ${missing.join(', ')}`);
  }
  return [...gaps].sort();
}

export interface OpenApiSpec {
  openapi: string;
  info: Record<string, unknown>;
  servers: Array<Record<string, unknown>>;
  tags: Array<{ name: string }>;
  components: Record<string, unknown>;
  paths: Record<string, Record<string, unknown>>;
}

export function buildOpenApiSpec(app: Pick<Hono, 'routes'>): OpenApiSpec {
  const seen = new Set<string>();
  const paths: Record<string, Record<string, unknown>> = {};
  const tags = new Set<string>();

  // Stable order so the generated file diffs cleanly.
  const routes = [...app.routes]
    .filter(
      (r) => (HTTP_METHODS as readonly string[]).includes(r.method) && !EXCLUDED_PATHS.has(r.path),
    )
    .sort((a, b) =>
      a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
    );

  for (const r of routes) {
    const method = r.method as HttpMethod;
    const dedupeKey = `${method} ${r.path}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const oaPath = toOpenApiPath(r.path);
    const tag = tagFor(r.path);
    tags.add(tag);
    const meta = routeMeta[`${method} ${oaPath}`];

    const operation: Record<string, unknown> = {
      tags: [tag],
      summary: meta?.summary ?? `${VERB_WORD[method]} ${oaPath}`,
      operationId: `${method.toLowerCase()}_${oaPath.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
    };
    if (meta?.description) operation['description'] = meta.description;

    const pathParams = pathParamNames(oaPath).map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    const queryParams = Object.entries(meta?.queryParams ?? {}).map(([name, qp]) => ({
      name,
      in: 'query',
      required: qp.required ?? false,
      ...(qp.description ? { description: qp.description } : {}),
      schema: jsonSchema(qp.schema),
    }));
    // Tenant-scoped adult routes can name the family with this header when the
    // JWT carries no tenant claim (see middleware/resolve-tenant.ts).
    const tenantHeader =
      !isPublicRoute(oaPath) && !oaPath.startsWith('/api/kid')
        ? [
            {
              name: 'x-tenant-slug',
              in: 'header',
              required: false,
              description: "The family's URL slug, e.g. khan-family.",
              schema: { type: 'string' },
            },
          ]
        : [];
    const allParams = [...pathParams, ...queryParams, ...tenantHeader];
    if (allParams.length) {
      operation['parameters'] = allParams;
    }

    const isPublic = isPublicRoute(oaPath);
    if (!isPublic) {
      // /api/kid/* authenticate with the kid PIN session token, NOT the
      // Supabase user JWT: document the right credential.
      operation['security'] = oaPath.startsWith('/api/kid')
        ? [{ kidAuth: [] }]
        : [{ bearerAuth: [] }];
    }

    if (meta?.request) {
      operation['requestBody'] = {
        required: true,
        content: { 'application/json': { schema: jsonSchema(meta.request) } },
      };
    }

    const status = String(meta?.status ?? 200);
    operation['responses'] = meta?.response
      ? {
          [status]: {
            description: meta.responseDesc ?? 'Success',
            content: { 'application/json': { schema: jsonSchema(meta.response) } },
          },
        }
      : meta?.responseContentType
        ? {
            [status]: {
              description: meta.responseDesc ?? 'Success',
              content: { [meta.responseContentType]: { schema: { type: 'string' } } },
            },
          }
        : { [status]: { description: meta?.responseDesc ?? 'Success' } };

    paths[oaPath] ??= {};
    paths[oaPath][method.toLowerCase()] = operation;
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Family Hub API',
      version: '0.1.0',
      description:
        'Multi-tenant family-coordination API. This spec is generated from the live Hono route table (FHS-356): every endpoint here is a real, mounted route.',
    },
    servers: [{ url: '/', description: 'current host' }],
    tags: [...tags].sort().map((name) => ({ name })),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Supabase user JWT (parent / adult sign-in).',
        },
        kidAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'kid-JWT',
          description: 'Kid PIN session token from POST /api/auth/kid-pin.',
        },
      },
    },
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
  };
}
