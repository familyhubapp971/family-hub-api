import { faker } from './_seed.js';

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  createdAt: Date;
}

export function buildTenant(overrides: Partial<Tenant> = {}): Tenant {
  // Derive slug from name so they stay consistent under partial overrides.
  const name = overrides.name ?? faker.company.name();
  const slug = overrides.slug ?? faker.helpers.slugify(name).toLowerCase();
  return {
    id: faker.string.uuid(),
    name,
    slug,
    createdAt: new Date(),
    ...overrides,
  };
}

export async function createTenant(
  _db: unknown,
  overrides: Partial<Tenant> = {},
): Promise<Tenant> {
  const tenant = buildTenant(overrides);
  // INSERT lands in FHS-1 once apps/api/src/db/schema.ts defines the
  // tenants table. Today the function is a build-only stub; specs
  // can use it for shape but cannot persist.
  if (process.env['FHS_TEST_UTILS_ALLOW_NOOP'] !== '1') {
    throw new Error(
      'createTenant: tenants table not defined yet (FHS-1). ' +
        'Use buildTenant() for object construction, or set ' +
        'FHS_TEST_UTILS_ALLOW_NOOP=1 to silence this in scaffolding tests.',
    );
  }
  return tenant;
}
