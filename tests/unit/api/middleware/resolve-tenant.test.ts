import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { resolveTenant } from '../../../../apps/api/src/middleware/resolve-tenant.js';

// FHS-13 + FHS-249 — resolveTenant precedence and edge cases.
//
// We exercise the middleware in isolation rather than through buildApp:
// it lets us seed the JWT-claim source by hand-setting `c.var.user`
// without minting a real Supabase token.

function makeAppWith({
  baseDomain,
  lookups,
  seedUser,
}: {
  baseDomain?: string;
  lookups: Record<string, string>;
  seedUser?: { id: string; claims: Record<string, unknown> };
}) {
  const lookupTenantId = vi.fn(async (slug: string) => lookups[slug]);
  const app = new Hono();
  if (seedUser) {
    app.use('*', async (c, next) => {
      c.set('user', { id: seedUser.id, claims: seedUser.claims });
      await next();
    });
  }
  app.use('*', resolveTenant({ lookupTenantId, baseDomain: baseDomain ?? 'localhost' }));
  app.get('*', (c) =>
    c.json({
      tenantId: c.get('tenantId'),
      tenantSlug: c.get('tenantSlug'),
    }),
  );
  return { app, lookupTenantId };
}

describe('FHS-13 + FHS-249 — resolveTenant', () => {
  describe('source 1 — JWT custom claim', () => {
    it('uses app_metadata.tenant_slug when the user is authenticated and the slug exists', async () => {
      const { app, lookupTenantId } = makeAppWith({
        lookups: { khans: 'tenant-uuid-khans' },
        seedUser: {
          id: 'user-1',
          claims: { app_metadata: { tenant_slug: 'khans' } },
        },
      });
      const res = await app.request('/anything');
      const body = await res.json();
      expect(body).toEqual({ tenantId: 'tenant-uuid-khans', tenantSlug: 'khans' });
      expect(lookupTenantId).toHaveBeenCalledWith('khans');
    });

    it('beats subdomain when both are present', async () => {
      const { app } = makeAppWith({
        baseDomain: 'familyhub.app',
        lookups: { khans: 'tenant-uuid-khans', smiths: 'tenant-uuid-smiths' },
        seedUser: { id: 'u', claims: { app_metadata: { tenant_slug: 'khans' } } },
      });
      const res = await app.request('/x', {
        headers: { host: 'smiths.familyhub.app' },
      });
      expect(await res.json()).toMatchObject({ tenantSlug: 'khans' });
    });

    it('beats path prefix when both are present', async () => {
      const { app } = makeAppWith({
        lookups: { khans: 'tenant-uuid-khans', smiths: 'tenant-uuid-smiths' },
        seedUser: { id: 'u', claims: { app_metadata: { tenant_slug: 'khans' } } },
      });
      const res = await app.request('/t/smiths/dashboard');
      expect(await res.json()).toMatchObject({ tenantSlug: 'khans' });
    });
  });

  describe('source 2 — subdomain', () => {
    it('parses <slug>.<BASE_DOMAIN> when BASE_DOMAIN is a real domain', async () => {
      const { app } = makeAppWith({
        baseDomain: 'familyhub.app',
        lookups: { khans: 'tenant-uuid-khans' },
      });
      const res = await app.request('/anything', {
        headers: { host: 'khans.familyhub.app' },
      });
      expect(await res.json()).toEqual({
        tenantId: 'tenant-uuid-khans',
        tenantSlug: 'khans',
      });
    });

    it('strips a port from the Host header before splitting', async () => {
      const { app } = makeAppWith({
        baseDomain: 'familyhub.app',
        lookups: { khans: 'tenant-uuid-khans' },
      });
      const res = await app.request('/x', {
        headers: { host: 'khans.familyhub.app:3001' },
      });
      expect(await res.json()).toMatchObject({ tenantSlug: 'khans' });
    });

    it('skips reserved subdomains (www, api, app, …)', async () => {
      const { app, lookupTenantId } = makeAppWith({
        baseDomain: 'familyhub.app',
        lookups: { www: 'should-never-resolve' },
      });
      const res = await app.request('/x', {
        headers: { host: 'www.familyhub.app' },
      });
      expect(await res.json()).toEqual({ tenantId: undefined, tenantSlug: undefined });
      expect(lookupTenantId).not.toHaveBeenCalled();
    });

    it('does NOT match nested subdomains (foo.khans.familyhub.app)', async () => {
      const { app, lookupTenantId } = makeAppWith({
        baseDomain: 'familyhub.app',
        lookups: { khans: 'tenant-uuid-khans' },
      });
      const res = await app.request('/x', {
        headers: { host: 'foo.khans.familyhub.app' },
      });
      // candidate would be 'foo.khans' — contains a dot, so we reject it.
      expect(await res.json()).toEqual({ tenantId: undefined, tenantSlug: undefined });
      expect(lookupTenantId).not.toHaveBeenCalled();
    });

    it('is a no-op when BASE_DOMAIN is localhost (local dev)', async () => {
      const { app, lookupTenantId } = makeAppWith({
        baseDomain: 'localhost',
        lookups: { anything: 'whatever' },
      });
      const res = await app.request('/x', { headers: { host: 'anything.localhost' } });
      expect(await res.json()).toEqual({ tenantId: undefined, tenantSlug: undefined });
      expect(lookupTenantId).not.toHaveBeenCalled();
    });
  });

  describe('source 3 — path prefix /t/<slug>/...', () => {
    it('extracts the slug and resolves the tenant', async () => {
      const { app } = makeAppWith({
        lookups: { khans: 'tenant-uuid-khans' },
      });
      const res = await app.request('/t/khans/dashboard');
      expect(await res.json()).toEqual({
        tenantId: 'tenant-uuid-khans',
        tenantSlug: 'khans',
      });
    });

    it('does not match /api/t/khans/... — the prefix must be at the path root', async () => {
      const { app, lookupTenantId } = makeAppWith({
        lookups: { khans: 'tenant-uuid-khans' },
      });
      const res = await app.request('/api/t/khans/me');
      expect(await res.json()).toEqual({ tenantId: undefined, tenantSlug: undefined });
      expect(lookupTenantId).not.toHaveBeenCalled();
    });

    it('rejects slugs with invalid characters', async () => {
      const { app, lookupTenantId } = makeAppWith({
        lookups: { 'BAD!': 'never' },
      });
      const res = await app.request('/t/BAD!/page');
      expect(await res.json()).toEqual({ tenantId: undefined, tenantSlug: undefined });
      expect(lookupTenantId).not.toHaveBeenCalled();
    });

    it('rejects an empty /t// path', async () => {
      const { app, lookupTenantId } = makeAppWith({ lookups: {} });
      const res = await app.request('/t//page');
      expect(await res.json()).toEqual({ tenantId: undefined, tenantSlug: undefined });
      expect(lookupTenantId).not.toHaveBeenCalled();
    });
  });

  describe('lookup miss', () => {
    it('leaves tenantId/tenantSlug undefined when the slug exists in the URL but not in the table', async () => {
      const { app } = makeAppWith({
        lookups: {}, // empty — no slug resolves
      });
      const res = await app.request('/t/ghost/dashboard');
      expect(await res.json()).toEqual({ tenantId: undefined, tenantSlug: undefined });
    });
  });
});
