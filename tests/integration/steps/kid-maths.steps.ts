/**
 * Step bindings for kid-maths.feature (FHS-394).
 *
 * Kid identity from kid token (no memberId param). Real Postgres on :5433.
 * Mirrors the kid-world-flags.steps.ts pattern: kidRouter + mintKidToken +
 * no-op pinRequestTenant mock.
 */

import { randomUUID } from 'node:crypto';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
  pinRequestTenant: async () => {},
}));

import { config } from '../../../apps/api/src/config.js';
import { kidRouter } from '../../../apps/api/src/routes/kid.js';
import { tenants, members } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';

const KID_ISSUER = 'family-hub-kid-auth';

let db: Database;
let app: Hono;
const tokens = new Map<string, string>();

// Last HTTP response captured per operation.
let progressPutRes: Response;
let progressGetRes: Response;
let placementRes: Response;
let certPostRes: Response;
let certGetRes: Response;

// Parsed response bodies (populated lazily in the step that reads back).
let progressListBody: { progress: Array<Record<string, unknown>> };
let placementBody: { unlocked: number[] };
let certPostBody: { certificate: Record<string, unknown>; alreadyEarned: boolean };
let certListBody: { certificates: Array<Record<string, unknown>> };

async function mintKidToken(memberId: string, tenantId: string, slug: string): Promise<string> {
  const secret = new TextEncoder().encode(config.KID_AUTH_SECRET);
  return new SignJWT({ tenantId, tenantSlug: slug, scope: 'child' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(memberId)
    .setIssuer(KID_ISSUER)
    .setExpirationTime('1h')
    .sign(secret);
}

const authFor = (name: string) => ({ Authorization: `Bearer ${tokens.get(name)}` });
const jsonAuth = (name: string) => ({ ...authFor(name), 'Content-Type': 'application/json' });

const feature = await loadFeature(
  new URL('../features/kid-maths.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given, And }) => {
    Given('a family with kid "Maya" in tenant "maths-fam"', async () => {
      db = getTestDb() as unknown as Database;

      // Clean slate for every scenario.
      await db.execute(sql`TRUNCATE TABLE mw_maths_certificates RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE mw_maths_progress RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);

      const [t] = await db
        .insert(tenants)
        .values({ slug: `maths-fam-${randomUUID().slice(0, 8)}`, name: 'Maths Fam' })
        .returning();

      const [maya] = await db
        .insert(members)
        .values({ tenantId: t!.id, displayName: 'Maya', role: 'child', isChild: true })
        .returning();

      tokens.set('Maya', await mintKidToken(maya!.id, t!.id, t!.slug));

      app = new Hono();
      app.route('/api/kid', kidRouter);
    });

    And('a second tenant with kid "Omar" in tenant "other-fam"', async () => {
      const [t2] = await db
        .insert(tenants)
        .values({ slug: `other-fam-${randomUUID().slice(0, 8)}`, name: 'Other Fam' })
        .returning();

      const [omar] = await db
        .insert(members)
        .values({ tenantId: t2!.id, displayName: 'Omar', role: 'child', isChild: true })
        .returning();

      tokens.set('Omar', await mintKidToken(omar!.id, t2!.id, t2!.slug));
    });
  });

  // ─── Scenario: upsert and read back ──────────────────────────────────────────

  Scenario('a kid can upsert their progress and read it back', ({ When, Then, And }) => {
    When(
      '"Maya" PUTs /api/kid/maths/progress with operation "addition" tableNumber 3 learnCompleted true',
      async () => {
        progressPutRes = await app.request('/api/kid/maths/progress', {
          method: 'PUT',
          headers: jsonAuth('Maya'),
          body: JSON.stringify({ operation: 'addition', tableNumber: 3, learnCompleted: true }),
        });
      },
    );
    Then('the maths progress PUT response status is 200', () =>
      expect(progressPutRes.status).toBe(200),
    );
    And('the maths progress PUT body has learnCompleted true', async () => {
      const body = (await progressPutRes.json()) as { learnCompleted: boolean };
      expect(body.learnCompleted).toBe(true);
    });
    When('"Maya" GETs /api/kid/maths/progress', async () => {
      progressGetRes = await app.request('/api/kid/maths/progress', { headers: authFor('Maya') });
      progressListBody = (await progressGetRes.json()) as typeof progressListBody;
    });
    Then('the maths progress GET response status is 200', () =>
      expect(progressGetRes.status).toBe(200),
    );
    And('the maths progress list contains a row with operation "addition" tableNumber 3', () => {
      const found = progressListBody.progress.some(
        (r) => r['operation'] === 'addition' && r['tableNumber'] === 3,
      );
      expect(found).toBe(true);
    });
  });

  // ─── Scenario: partial update does not reset other fields ─────────────────────

  Scenario('updating only practiceCorrect does not reset learnCompleted', ({ When, Then, And }) => {
    When(
      '"Maya" PUTs /api/kid/maths/progress with operation "subtraction" tableNumber 1 learnCompleted true',
      async () => {
        await app.request('/api/kid/maths/progress', {
          method: 'PUT',
          headers: jsonAuth('Maya'),
          body: JSON.stringify({ operation: 'subtraction', tableNumber: 1, learnCompleted: true }),
        });
      },
    );
    And(
      '"Maya" PUTs /api/kid/maths/progress with operation "subtraction" tableNumber 1 practiceCorrect 5',
      async () => {
        await app.request('/api/kid/maths/progress', {
          method: 'PUT',
          headers: jsonAuth('Maya'),
          body: JSON.stringify({ operation: 'subtraction', tableNumber: 1, practiceCorrect: 5 }),
        });
      },
    );
    When('"Maya" GETs /api/kid/maths/progress', async () => {
      progressGetRes = await app.request('/api/kid/maths/progress', { headers: authFor('Maya') });
      progressListBody = (await progressGetRes.json()) as typeof progressListBody;
    });
    Then('the subtraction table 1 row has learnCompleted true and practiceCorrect 5', () => {
      const row = progressListBody.progress.find(
        (r) => r['operation'] === 'subtraction' && r['tableNumber'] === 1,
      );
      expect(row).toBeDefined();
      expect(row!['learnCompleted']).toBe(true);
      expect(row!['practiceCorrect']).toBe(5);
    });
  });

  // ─── Scenario: placement cascade ─────────────────────────────────────────────

  Scenario(
    'placement cascade masters qualifying tables and writes certs',
    ({ When, Then, And }) => {
      When(
        '"Maya" POSTs /api/kid/maths/placement with operation "multiplication" and result tableNumber 3 correct true timeSeconds 3',
        async () => {
          placementRes = await app.request('/api/kid/maths/placement', {
            method: 'POST',
            headers: jsonAuth('Maya'),
            body: JSON.stringify({
              operation: 'multiplication',
              results: [{ tableNumber: 3, correct: true, timeSeconds: 3 }],
            }),
          });
          placementBody = (await placementRes.json()) as typeof placementBody;
        },
      );
      Then('the placement response status is 200', () => expect(placementRes.status).toBe(200));
      And('the unlocked list contains 3', () => expect(placementBody.unlocked).toContain(3));
      When('"Maya" GETs /api/kid/maths/progress', async () => {
        progressGetRes = await app.request('/api/kid/maths/progress', { headers: authFor('Maya') });
        progressListBody = (await progressGetRes.json()) as typeof progressListBody;
      });
      Then('the multiplication table 3 row has placementUnlocked true', () => {
        const row = progressListBody.progress.find(
          (r) => r['operation'] === 'multiplication' && r['tableNumber'] === 3,
        );
        expect(row).toBeDefined();
        expect(row!['placementUnlocked']).toBe(true);
      });
      When('"Maya" GETs /api/kid/maths/certificates', async () => {
        certGetRes = await app.request('/api/kid/maths/certificates', { headers: authFor('Maya') });
        certListBody = (await certGetRes.json()) as typeof certListBody;
      });
      Then(
        'the certificates list contains an entry for operation "multiplication" difficulty "3"',
        () => {
          const found = certListBody.certificates.some(
            (c) => c['operation'] === 'multiplication' && c['difficulty'] === '3',
          );
          expect(found).toBe(true);
        },
      );
    },
  );

  // ─── Scenario: placement idempotency ─────────────────────────────────────────

  Scenario(
    'placement is idempotent — a second call does not duplicate rows',
    ({ When, Then, And }) => {
      When(
        '"Maya" POSTs /api/kid/maths/placement with operation "division" and result tableNumber 2 correct true timeSeconds 2',
        async () => {
          await app.request('/api/kid/maths/placement', {
            method: 'POST',
            headers: jsonAuth('Maya'),
            body: JSON.stringify({
              operation: 'division',
              results: [{ tableNumber: 2, correct: true, timeSeconds: 2 }],
            }),
          });
        },
      );
      And(
        '"Maya" POSTs /api/kid/maths/placement with operation "division" and result tableNumber 2 correct true timeSeconds 2',
        async () => {
          await app.request('/api/kid/maths/placement', {
            method: 'POST',
            headers: jsonAuth('Maya'),
            body: JSON.stringify({
              operation: 'division',
              results: [{ tableNumber: 2, correct: true, timeSeconds: 2 }],
            }),
          });
        },
      );
      When('"Maya" GETs /api/kid/maths/certificates', async () => {
        certGetRes = await app.request('/api/kid/maths/certificates', { headers: authFor('Maya') });
        certListBody = (await certGetRes.json()) as typeof certListBody;
      });
      Then('the division certificates count for table "2" is 1', () => {
        const matches = certListBody.certificates.filter(
          (c) => c['operation'] === 'division' && c['difficulty'] === '2',
        );
        expect(matches).toHaveLength(1);
      });
    },
  );

  // ─── Scenario: earn a cert (new) ─────────────────────────────────────────────

  Scenario(
    'a kid earns a certificate and it is returned with alreadyEarned false',
    ({ When, Then, And }) => {
      When(
        '"Maya" POSTs /api/kid/maths/certificates with operation "addition" difficulty "easy" totalCorrect 12',
        async () => {
          certPostRes = await app.request('/api/kid/maths/certificates', {
            method: 'POST',
            headers: jsonAuth('Maya'),
            body: JSON.stringify({ operation: 'addition', difficulty: 'easy', totalCorrect: 12 }),
          });
          certPostBody = (await certPostRes.json()) as typeof certPostBody;
        },
      );
      Then('the cert POST response status is 201', () => expect(certPostRes.status).toBe(201));
      And('the cert response has alreadyEarned false', () =>
        expect(certPostBody.alreadyEarned).toBe(false),
      );
    },
  );

  // ─── Scenario: cert idempotency ───────────────────────────────────────────────

  Scenario(
    'posting the same certificate twice returns alreadyEarned true',
    ({ When, Then, And }) => {
      When(
        '"Maya" POSTs /api/kid/maths/certificates with operation "addition" difficulty "hard" totalCorrect 10',
        async () => {
          await app.request('/api/kid/maths/certificates', {
            method: 'POST',
            headers: jsonAuth('Maya'),
            body: JSON.stringify({ operation: 'addition', difficulty: 'hard', totalCorrect: 10 }),
          });
        },
      );
      And(
        '"Maya" POSTs /api/kid/maths/certificates with operation "addition" difficulty "hard" totalCorrect 10',
        async () => {
          certPostRes = await app.request('/api/kid/maths/certificates', {
            method: 'POST',
            headers: jsonAuth('Maya'),
            body: JSON.stringify({ operation: 'addition', difficulty: 'hard', totalCorrect: 10 }),
          });
          certPostBody = (await certPostRes.json()) as typeof certPostBody;
        },
      );
      Then('the cert response has alreadyEarned true', () =>
        expect(certPostBody.alreadyEarned).toBe(true),
      );
    },
  );

  // ─── Scenario: tenant isolation — progress ────────────────────────────────────

  Scenario(
    "tenant isolation — a kid in another tenant sees zero of Maya's progress",
    ({ When, Then, And }) => {
      When(
        '"Maya" PUTs /api/kid/maths/progress with operation "addition" tableNumber 5 learnCompleted true',
        async () => {
          await app.request('/api/kid/maths/progress', {
            method: 'PUT',
            headers: jsonAuth('Maya'),
            body: JSON.stringify({ operation: 'addition', tableNumber: 5, learnCompleted: true }),
          });
        },
      );
      When('"Omar" GETs /api/kid/maths/progress', async () => {
        progressGetRes = await app.request('/api/kid/maths/progress', { headers: authFor('Omar') });
        progressListBody = (await progressGetRes.json()) as typeof progressListBody;
      });
      Then('the maths progress GET response status is 200', () =>
        expect(progressGetRes.status).toBe(200),
      );
      And('the maths progress list is empty', () =>
        expect(progressListBody.progress).toHaveLength(0),
      );
    },
  );

  // ─── Scenario: tenant isolation — certificates ────────────────────────────────

  Scenario(
    "tenant isolation — a kid in another tenant sees zero of Maya's certificates",
    ({ When, Then }) => {
      When(
        '"Maya" POSTs /api/kid/maths/certificates with operation "multiplication" difficulty "6" totalCorrect 10',
        async () => {
          await app.request('/api/kid/maths/certificates', {
            method: 'POST',
            headers: jsonAuth('Maya'),
            body: JSON.stringify({
              operation: 'multiplication',
              difficulty: '6',
              totalCorrect: 10,
            }),
          });
        },
      );
      When('"Omar" GETs /api/kid/maths/certificates', async () => {
        certGetRes = await app.request('/api/kid/maths/certificates', { headers: authFor('Omar') });
        certListBody = (await certGetRes.json()) as typeof certListBody;
      });
      Then('the certificates list is empty', () =>
        expect(certListBody.certificates).toHaveLength(0),
      );
    },
  );

  // ─── Scenario: same-tenant member isolation ───────────────────────────────────

  Scenario(
    "same-tenant member isolation — a sibling sees none of Maya's progress",
    ({ Given, When, Then, And }) => {
      Given('a sibling "Lily" in the same tenant as Maya', async () => {
        // Resolve Maya's tenant from the existing token (tenantId is in the JWT).
        // We need the real tenantId — look it up from the members table via Maya's token,
        // which we can do by querying the DB for the sole 'maths-fam' tenant inserted in Background.
        const [tenant] = await db.select({ id: tenants.id }).from(tenants).limit(1);
        const [lily] = await db
          .insert(members)
          .values({ tenantId: tenant!.id, displayName: 'Lily', role: 'child', isChild: true })
          .returning();
        tokens.set('Lily', await mintKidToken(lily!.id, tenant!.id, 'maths-fam'));
      });

      When(
        '"Maya" PUTs /api/kid/maths/progress with operation "addition" tableNumber 7 learnCompleted true',
        async () => {
          await app.request('/api/kid/maths/progress', {
            method: 'PUT',
            headers: jsonAuth('Maya'),
            body: JSON.stringify({ operation: 'addition', tableNumber: 7, learnCompleted: true }),
          });
        },
      );
      And(
        '"Maya" POSTs /api/kid/maths/certificates with operation "addition" difficulty "7" totalCorrect 10',
        async () => {
          await app.request('/api/kid/maths/certificates', {
            method: 'POST',
            headers: jsonAuth('Maya'),
            body: JSON.stringify({ operation: 'addition', difficulty: '7', totalCorrect: 10 }),
          });
        },
      );
      When('"Lily" GETs /api/kid/maths/progress', async () => {
        progressGetRes = await app.request('/api/kid/maths/progress', { headers: authFor('Lily') });
        progressListBody = (await progressGetRes.json()) as typeof progressListBody;
      });
      Then('the maths progress list is empty', () =>
        expect(progressListBody.progress).toHaveLength(0),
      );
      When('"Lily" GETs /api/kid/maths/certificates', async () => {
        certGetRes = await app.request('/api/kid/maths/certificates', { headers: authFor('Lily') });
        certListBody = (await certGetRes.json()) as typeof certListBody;
      });
      Then('the certificates list is empty', () =>
        expect(certListBody.certificates).toHaveLength(0),
      );
    },
  );

  // ─── Scenario: all-wrong placement ────────────────────────────────────────────

  Scenario(
    'all-wrong placement returns empty unlocked and writes no rows',
    ({ When, Then, And }) => {
      When(
        '"Maya" POSTs /api/kid/maths/placement with all-wrong results for operation "addition" tableNumber 5',
        async () => {
          placementRes = await app.request('/api/kid/maths/placement', {
            method: 'POST',
            headers: jsonAuth('Maya'),
            body: JSON.stringify({
              operation: 'addition',
              results: [{ tableNumber: 5, correct: false, timeSeconds: 1 }],
            }),
          });
          placementBody = (await placementRes.json()) as typeof placementBody;
        },
      );
      Then('the placement response status is 200', () => expect(placementRes.status).toBe(200));
      And('the unlocked list is empty', () => expect(placementBody.unlocked).toHaveLength(0));
      When('"Maya" GETs /api/kid/maths/progress', async () => {
        progressGetRes = await app.request('/api/kid/maths/progress', { headers: authFor('Maya') });
        progressListBody = (await progressGetRes.json()) as typeof progressListBody;
      });
      Then('the maths progress list is empty', () =>
        expect(progressListBody.progress).toHaveLength(0),
      );
    },
  );
});
