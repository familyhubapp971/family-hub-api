import { faker } from './_seed.js';

export interface Family {
  id: string;
  tenantId: string;
  name: string;
  memberIds: string[];
  createdAt: Date;
}

export function buildFamily(overrides: Partial<Family> = {}): Family {
  return {
    id: faker.string.uuid(),
    tenantId: overrides.tenantId ?? faker.string.uuid(),
    name: `${faker.person.lastName()} family`,
    memberIds: [],
    createdAt: new Date(),
    ...overrides,
  };
}

export async function createFamily(
  _db: unknown,
  tenantId: string,
  overrides: Partial<Family> = {},
): Promise<Family> {
  const family = buildFamily({ ...overrides, tenantId });
  if (process.env['FHS_TEST_UTILS_ALLOW_NOOP'] !== '1') {
    throw new Error(
      'createFamily: families table not defined yet (FHS-1+). ' +
        'Use buildFamily() for object construction.',
    );
  }
  return family;
}
