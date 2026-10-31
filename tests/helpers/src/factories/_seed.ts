import { faker } from '@faker-js/faker';

const DEFAULT_SEED = 42;

// Determinism: seed faker so factory output is reproducible across runs.
// Call seedFaker() in a global beforeAll for stable assertions; call
// resetFaker() between tests if you want fresh randomness within a run.

export function seedFaker(seed: number = DEFAULT_SEED): void {
  faker.seed(seed);
}

export function resetFaker(): void {
  faker.seed();
}

export { faker };
