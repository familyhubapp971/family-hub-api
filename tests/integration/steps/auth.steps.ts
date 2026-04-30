import http from 'node:http';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import {
  SignJWT,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyLike,
} from 'jose';
import { expect } from 'vitest';
import { authMiddleware, getAuthenticatedUser } from '@familyhub/api/middleware/auth';

const ALG = 'ES256';
const KID = 'integration-key-1';
const TRUSTED_ISSUER_PATH = '/auth/v1';

type Keypair = { privateKey: KeyLike; publicJwk: JWK };

const feature = await loadFeature(new URL('../features/auth.feature', import.meta.url).pathname);

let trustedKey: Keypair;
let server: http.Server;
let serverUrl: string;
let issuer: string;

async function generateKey(kid = KID): Promise<Keypair> {
  const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = ALG;
  publicJwk.kid = kid;
  publicJwk.use = 'sig';
  return { privateKey, publicJwk };
}

async function mintToken(
  privateKey: KeyLike,
  opts: {
    sub?: string;
    email?: string;
    expSecondsFromNow?: number;
    issuer?: string;
    kid?: string;
  } = {},
): Promise<string> {
  const sub = opts.sub ?? 'integration-user-1';
  const exp = Math.floor(Date.now() / 1000) + (opts.expSecondsFromNow ?? 3600);
  const payload: Record<string, unknown> = {};
  if (opts.email !== undefined) payload['email'] = opts.email;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: ALG, kid: opts.kid ?? KID })
    .setSubject(sub)
    .setIssuer(opts.issuer ?? issuer)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(privateKey);
}

function buildApp(supabaseUrlOverride?: string) {
  const app = new Hono();
  const jwks = createRemoteJWKSet(
    new URL(`${supabaseUrlOverride ?? serverUrl}/auth/v1/.well-known/jwks.json`),
    { cacheMaxAge: 60_000, cooldownDuration: 5_000 },
  );
  app.use('*', authMiddleware({ jwks, issuer }));
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/me', (c) => {
    const user = getAuthenticatedUser(c);
    return c.json({ id: user.id, email: user.email });
  });
  return app;
}

describeFeature(feature, ({ Scenario, ScenarioOutline, BeforeAllScenarios, AfterAllScenarios }) => {
  BeforeAllScenarios(async () => {
    trustedKey = await generateKey();
    server = http.createServer((req, res) => {
      if (req.url === `${TRUSTED_ISSUER_PATH}/.well-known/jwks.json`) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ keys: [trustedKey.publicJwk] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('failed to bind JWKS server');
    serverUrl = `http://127.0.0.1:${addr.port}`;
    issuer = `${serverUrl}${TRUSTED_ISSUER_PATH}`;
  });

  AfterAllScenarios(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  Scenario('Valid token — JWKS fetched and cached', ({ Given, And, When, Then }) => {
    let app: ReturnType<typeof buildApp>;
    let token: string;
    let last: Response;

    Given('the api uses the trusted JWKS', () => {
      app = buildApp();
    });
    And(
      'a valid token signed by the trusted key with sub "u-int-1" and email "int@example.com"',
      async () => {
        token = await mintToken(trustedKey.privateKey, {
          sub: 'u-int-1',
          email: 'int@example.com',
        });
      },
    );
    When('I GET /me with that bearer token', async () => {
      last = await app.request('/me', { headers: { Authorization: `Bearer ${token}` } });
    });
    Then('the response status is 200', () => {
      expect(last.status).toBe(200);
    });
    And('the body equals { "id": "u-int-1", "email": "int@example.com" }', async () => {
      expect(await last.json()).toEqual({ id: 'u-int-1', email: 'int@example.com' });
    });
  });

  Scenario('Two valid calls — second one hits the JWKS cache', ({ Given, And, When, Then }) => {
    let app: ReturnType<typeof buildApp>;
    let t1: string;
    let t2: string;
    let r1: Response;
    let r2: Response;

    Given('the api uses the trusted JWKS', () => {
      app = buildApp();
    });
    And('a valid token signed by the trusted key with sub "u-int-2" and no email', async () => {
      t1 = await mintToken(trustedKey.privateKey, { sub: 'u-int-2' });
    });
    And(
      'another valid token signed by the trusted key with sub "u-int-3" and no email',
      async () => {
        t2 = await mintToken(trustedKey.privateKey, { sub: 'u-int-3' });
      },
    );
    When('I GET /me with the first token', async () => {
      r1 = await app.request('/me', { headers: { Authorization: `Bearer ${t1}` } });
    });
    And('I GET /me with the second token', async () => {
      r2 = await app.request('/me', { headers: { Authorization: `Bearer ${t2}` } });
    });
    Then('both responses have status 200', () => {
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
    });
  });

  Scenario('Token that expired 60 seconds ago returns 401', ({ Given, And, When, Then }) => {
    let app: ReturnType<typeof buildApp>;
    let token: string;
    let last: Response;

    Given('the api uses the trusted JWKS', () => {
      app = buildApp();
    });
    And('a token signed by the trusted key that expired 60 seconds ago', async () => {
      token = await mintToken(trustedKey.privateKey, { expSecondsFromNow: -60 });
    });
    When('I GET /me with that bearer token', async () => {
      last = await app.request('/me', { headers: { Authorization: `Bearer ${token}` } });
    });
    Then('the response status is 401', () => {
      expect(last.status).toBe(401);
    });
    And('the body equals { "error": "unauthorized" }', async () => {
      expect(await last.json()).toEqual({ error: 'unauthorized' });
    });
  });

  Scenario(
    'Token expired by 1 second still returns 401 (expiry boundary)',
    ({ Given, And, When, Then }) => {
      let app: ReturnType<typeof buildApp>;
      let token: string;
      let last: Response;

      Given('the api uses the trusted JWKS', () => {
        app = buildApp();
      });
      And('a token signed by the trusted key that expired 1 second ago', async () => {
        token = await mintToken(trustedKey.privateKey, { expSecondsFromNow: -1 });
      });
      When('I GET /me with that bearer token', async () => {
        last = await app.request('/me', { headers: { Authorization: `Bearer ${token}` } });
      });
      Then('the response status is 401', () => {
        expect(last.status).toBe(401);
      });
    },
  );

  Scenario('Token issued by an untrusted issuer returns 401', ({ Given, And, When, Then }) => {
    let app: ReturnType<typeof buildApp>;
    let token: string;
    let last: Response;

    Given('the api uses the trusted JWKS', () => {
      app = buildApp();
    });
    And(
      'a token signed by the trusted key but issued by "https://attacker.example/auth/v1"',
      async () => {
        token = await mintToken(trustedKey.privateKey, {
          issuer: 'https://attacker.example/auth/v1',
        });
      },
    );
    When('I GET /me with that bearer token', async () => {
      last = await app.request('/me', { headers: { Authorization: `Bearer ${token}` } });
    });
    Then('the response status is 401', () => {
      expect(last.status).toBe(401);
    });
  });

  Scenario('Missing Authorization header returns 401', ({ Given, When, Then }) => {
    let app: ReturnType<typeof buildApp>;
    let last: Response;

    Given('the api uses the trusted JWKS', () => {
      app = buildApp();
    });
    When('I GET /me with no Authorization header', async () => {
      last = await app.request('/me');
    });
    Then('the response status is 401', () => {
      expect(last.status).toBe(401);
    });
  });

  Scenario(
    'Token signed by an untrusted key with the trusted kid returns 401',
    ({ Given, And, When, Then }) => {
      let app: ReturnType<typeof buildApp>;
      let token: string;
      let last: Response;

      Given('the api uses the trusted JWKS', () => {
        app = buildApp();
      });
      And('a token signed by an attacker key but stamped with the trusted kid', async () => {
        const attacker = await generateKey();
        token = await mintToken(attacker.privateKey, { kid: KID });
      });
      When('I GET /me with that bearer token', async () => {
        last = await app.request('/me', { headers: { Authorization: `Bearer ${token}` } });
      });
      Then('the response status is 401', () => {
        expect(last.status).toBe(401);
      });
    },
  );

  Scenario('Token with an unknown kid returns 401', ({ Given, And, When, Then }) => {
    let app: ReturnType<typeof buildApp>;
    let token: string;
    let last: Response;

    Given('the api uses the trusted JWKS', () => {
      app = buildApp();
    });
    And('a token signed by a different key with kid "untrusted-kid"', async () => {
      const other = await generateKey('untrusted-kid');
      token = await mintToken(other.privateKey, { kid: 'untrusted-kid' });
    });
    When('I GET /me with that bearer token', async () => {
      last = await app.request('/me', { headers: { Authorization: `Bearer ${token}` } });
    });
    Then('the response status is 401', () => {
      expect(last.status).toBe(401);
    });
  });

  ScenarioOutline('Malformed Authorization headers return 401', ({ Given, When, Then }, vars) => {
    let app: ReturnType<typeof buildApp>;
    let last: Response;

    Given('the api uses the trusted JWKS', () => {
      app = buildApp();
    });
    When(`I GET /me with the Authorization header set to "<header>"`, async () => {
      last = await app.request('/me', { headers: { Authorization: vars['header'] ?? '' } });
    });
    Then('the response status is 401', () => {
      expect(last.status).toBe(401);
    });
  });

  Scenario('/health is public — passes without a token', ({ Given, When, Then }) => {
    let app: ReturnType<typeof buildApp>;
    let last: Response;

    Given('the api uses the trusted JWKS', () => {
      app = buildApp();
    });
    When('I GET /health on the auth-test app with no Authorization header', async () => {
      last = await app.request('/health');
    });
    Then('the response status is 200', () => {
      expect(last.status).toBe(200);
    });
  });

  Scenario('JWKS unreachable — fail-closed 401, not 500', ({ Given, And, When, Then }) => {
    let app: ReturnType<typeof buildApp>;
    let token: string;
    let last: Response;

    Given('the api JWKS URL points at a dead port', () => {
      app = buildApp('http://127.0.0.1:1');
    });
    And('a valid token signed by the trusted key with sub "u-int-9" and no email', async () => {
      token = await mintToken(trustedKey.privateKey, { sub: 'u-int-9' });
    });
    When('I GET /me with that bearer token', async () => {
      last = await app.request('/me', { headers: { Authorization: `Bearer ${token}` } });
    });
    Then('the response status is 401', () => {
      expect(last.status).toBe(401);
    });
  });

  Scenario(
    "Oversized token (10 KB email claim) — verifies, doesn't crash",
    ({ Given, And, When, Then }) => {
      let app: ReturnType<typeof buildApp>;
      let token: string;
      let last: Response;
      let healthAfter: Response;

      Given('the api uses the trusted JWKS', () => {
        app = buildApp();
      });
      And('a valid token signed by the trusted key with a 10 KB email claim', async () => {
        // 10 KB local-part + standard @example.com domain.
        const huge = 'x'.repeat(10_000);
        token = await mintToken(trustedKey.privateKey, {
          sub: 'u-int-huge',
          email: `${huge}@example.com`,
        });
      });
      When('I GET /me with that bearer token', async () => {
        last = await app.request('/me', { headers: { Authorization: `Bearer ${token}` } });
      });
      Then('the response status is 200', () => {
        expect(last.status).toBe(200);
      });
      And('the api is still responsive on /health', async () => {
        healthAfter = await app.request('/health');
        expect(healthAfter.status).toBe(200);
      });
    },
  );
});
