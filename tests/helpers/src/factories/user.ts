import { faker } from './_seed.js';

export interface User {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  createdAt: Date;
}

export function buildUser(overrides: Partial<User> = {}): User {
  const id = overrides.id ?? faker.string.uuid();
  // Salt the email with the user id so two seeded users don't collide
  // on a unique constraint when FHS-1 enables the users table.
  const fallbackEmail = `${faker.internet.userName().toLowerCase()}+${id.slice(0, 8)}@example.com`;
  return {
    id,
    tenantId: overrides.tenantId ?? faker.string.uuid(),
    email: overrides.email ?? fallbackEmail,
    displayName: overrides.displayName ?? faker.person.fullName(),
    createdAt: new Date(),
    ...overrides,
  };
}

export async function createUser(
  _db: unknown,
  tenantId: string,
  overrides: Partial<User> = {},
): Promise<User> {
  const user = buildUser({ ...overrides, tenantId });
  if (process.env['FHS_TEST_UTILS_ALLOW_NOOP'] !== '1') {
    throw new Error(
      'createUser: users table not defined yet (FHS-1 / FHS-192). ' +
        'Use buildUser() for object construction.',
    );
  }
  return user;
}
