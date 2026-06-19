import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { expect, vi } from 'vitest';
import {
  kidPinRouter,
  _resetKidPinBucketsForTests,
} from '../../../apps/api/src/routes/auth-kid-pin.js';
import { tenants, members } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
  // FHS-354 — pin is a no-op here (tests run as the superuser, which bypasses RLS).
  pinRequestTenant: async () => {},
}));

// `vi.mock` factories are hoisted above any module-scope `const`, so
// the secret has to live inside the factory; we re-export it via the
// `_KID_AUTH_SECRET_FOR_TESTS` constant below for the assertions.
vi.mock('../../../apps/api/src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../apps/api/src/config.js')>(
    '../../../apps/api/src/config.js',
  );
  return {
    ...actual,
    config: {
      ...actual.config,
      KID_AUTH_SECRET: 'a-secret-of-at-least-thirty-two-chars-x',
      KID_PIN_LOCKOUT_MAX_ATTEMPTS: 5,
      KID_PIN_LOCKOUT_MS: 15 * 60_000,
      KID_JWT_TTL_MS: 60 * 60_000,
    },
  };
});

const KID_AUTH_SECRET = 'a-secret-of-at-least-thirty-two-chars-x';

const feature = await loadFeature(
  new URL('../features/auth-kid-pin.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  const tenantIds: Record<string, string> = {};
  const memberIds: Record<string, string> = {};

  Background(({ Given }) => {
    Given('the test Postgres has clean tenants and members tables', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      _resetKidPinBucketsForTests();
      for (const k of Object.keys(tenantIds)) delete tenantIds[k];
      for (const k of Object.keys(memberIds)) delete memberIds[k];
      app = new Hono();
      app.route('/api/auth/kid-pin', kidPinRouter);
    });
  });

  async function postPin(slug: string, memberId: string, pin: string) {
    return app.request('/api/auth/kid-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantSlug: slug, memberId, pin }),
    });
  }

  Scenario(
    'Valid PIN returns 200 with a JWT carrying scope=child',
    ({ Given, When, Then, And }) => {
      let res: Response;
      let body: { token: string; member: { id: string } };

      Given(
        'a tenant {string} exists with a kid member {string} with PIN {string}',
        async (_ctx, slug: string, name: string, pin: string) => {
          const [t] = await db
            .insert(tenants)
            .values({ slug, name: `${slug} Family` })
            .returning();
          tenantIds[slug] = t!.id;
          const hash = await bcrypt.hash(pin, 4);
          const [m] = await db
            .insert(members)
            .values({
              tenantId: t!.id,
              displayName: name,
              role: 'child',
              isChild: true,
              pinHash: hash,
            })
            .returning();
          memberIds[name] = m!.id;
        },
      );

      When(
        'the kid POSTs the correct PIN for {string} in tenant {string}',
        async (_ctx, name: string, slug: string) => {
          res = await postPin(slug, memberIds[name]!, '1234');
          body = (await res.json()) as { token: string; member: { id: string } };
        },
      );

      Then('the response status is 200', () => {
        expect(res.status).toBe(200);
      });

      And(
        "the response token decodes with scope {string} and the member's id",
        async (_ctx, scope: string) => {
          const secret = new TextEncoder().encode(KID_AUTH_SECRET);
          const { payload } = await jwtVerify(body.token, secret, {
            issuer: 'family-hub-kid-auth',
          });
          expect(payload.scope).toBe(scope);
          expect(payload.sub).toBe(body.member.id);
        },
      );
    },
  );

  Scenario('Wrong PIN returns 401 with a generic envelope', ({ Given, When, Then }) => {
    let res: Response;

    Given(
      'a tenant {string} exists with a kid member {string} with PIN {string}',
      async (_ctx, slug: string, name: string, pin: string) => {
        const [t] = await db
          .insert(tenants)
          .values({ slug, name: `${slug} Family` })
          .returning();
        tenantIds[slug] = t!.id;
        const hash = await bcrypt.hash(pin, 4);
        const [m] = await db
          .insert(members)
          .values({
            tenantId: t!.id,
            displayName: name,
            role: 'child',
            isChild: true,
            pinHash: hash,
          })
          .returning();
        memberIds[name] = m!.id;
      },
    );

    When(
      'the kid POSTs the wrong PIN {string} for {string} in tenant {string}',
      async (_ctx, pin: string, name: string, slug: string) => {
        res = await postPin(slug, memberIds[name]!, pin);
      },
    );

    Then('the response status is 401', () => {
      expect(res.status).toBe(401);
    });
  });

  Scenario(
    'A non-kid member with no PIN returns 401 (cannot enumerate eligibility)',
    ({ Given, When, Then }) => {
      let res: Response;

      Given(
        'a tenant {string} exists with an adult member {string} who has no PIN',
        async (_ctx, slug: string, name: string) => {
          const [t] = await db
            .insert(tenants)
            .values({ slug, name: `${slug} Family` })
            .returning();
          tenantIds[slug] = t!.id;
          const [m] = await db
            .insert(members)
            .values({ tenantId: t!.id, displayName: name, role: 'adult' })
            .returning();
          memberIds[name] = m!.id;
        },
      );

      When(
        'the kid POSTs PIN {string} for {string} in tenant {string}',
        async (_ctx, pin: string, name: string, slug: string) => {
          res = await postPin(slug, memberIds[name]!, pin);
        },
      );

      Then('the response status is 401', () => {
        expect(res.status).toBe(401);
      });
    },
  );
});
