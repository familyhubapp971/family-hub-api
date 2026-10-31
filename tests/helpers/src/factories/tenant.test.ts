import { describe, it, expect } from 'vitest';
import { buildTenant, createTenant } from './tenant.js';
import { seedFaker } from './_seed.js';

describe('buildTenant', () => {
  it('produces a typed Tenant with deterministic output under seed', () => {
    seedFaker(123);
    const a = buildTenant();
    seedFaker(123);
    const b = buildTenant();
    expect(a.id).toBe(b.id);
    expect(a.slug).toBe(b.slug);
    expect(a.name).toBe(b.name);
  });

  it('respects overrides', () => {
    const t = buildTenant({ slug: 'acme', name: 'ACME Inc' });
    expect(t.slug).toBe('acme');
    expect(t.name).toBe('ACME Inc');
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('createTenant', () => {
  it('throws until FHS-1 lands the tenants table', async () => {
    await expect(createTenant({})).rejects.toThrow(/FHS-1/);
  });
});
