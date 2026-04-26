// Test JWT helper. Real Supabase-issued JWTs land in FHS-191 / FHS-197.
// Until then this returns an unsigned, deterministic token shape so
// integration specs can pass an x-tenant-id header today and switch
// to bearer auth later without changing test code.

export interface TestJwtClaims {
  sub: string; // user id
  tenant_id: string;
  email?: string;
  exp?: number;
}

export function mintTestJwt(claims: TestJwtClaims): string {
  // Refuse to mint outside a test environment. Even though the api
  // verifier rejects alg=none in prod, the minter shouldn't be callable
  // from a non-test bundle in the first place.
  if (process.env['NODE_ENV'] !== 'test' && process.env['VITEST'] !== 'true') {
    throw new Error(
      'mintTestJwt is test-only — set NODE_ENV=test or run via Vitest.',
    );
  }
  // Plain JSON encoded as base64url. Not signed. The api accepts this
  // only when NODE_ENV === 'test' AND the route is behind the test-only
  // middleware (TBD in FHS-191). Production paths reject it.
  const header = encodeBase64Url('{"alg":"none","typ":"JWT"}');
  const now = Math.floor(Date.now() / 1000);
  const payload = encodeBase64Url(
    JSON.stringify({
      iss: 'familyhub-test',
      iat: now,
      nbf: now,
      exp: nowPlus(3600),
      ...claims,
    }),
  );
  return `${header}.${payload}.`;
}

function encodeBase64Url(input: string): string {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function nowPlus(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}
