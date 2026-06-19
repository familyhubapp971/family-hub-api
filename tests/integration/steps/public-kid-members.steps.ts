import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { expect, vi } from 'vitest';
import { publicKidMembersRouter } from '../../../apps/api/src/routes/public-kid-members.js';
import { tenants, members } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
  // FHS-354 — pin is a no-op here (tests run as the superuser, which bypasses RLS).
  pinRequestTenant: async () => {},
}));

const feature = await loadFeature(
  new URL('../features/public-kid-members.feature', import.meta.url).pathname,
);

interface MemberRow {
  name: string;
  role: string;
  pin: string;
}

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;

  Background(({ Given }) => {
    Given('the test Postgres has clean tenants and members tables', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      app = new Hono();
      app.route('/api/public/kid-members', publicKidMembersRouter);
    });
  });

  async function seedTenantWithMembers(slug: string, name: string, rows: MemberRow[]) {
    const [t] = await db.insert(tenants).values({ slug, name }).returning();
    for (const row of rows) {
      const isChild = row.role === 'child';
      const pinHash = row.pin ? await bcrypt.hash(row.pin, 4) : null;
      await db.insert(members).values({
        tenantId: t!.id,
        displayName: row.name,
        role: row.role,
        isChild,
        pinHash,
      });
    }
  }

  Scenario(
    'Returns family + only kids with PINs, sorted alphabetically',
    ({ Given, When, Then, And }) => {
      let res: Response;
      let body: { family: { name: string }; kids: { displayName: string }[] };

      Given(
        'the tenant {string} named {string} has these members:',
        async (_ctx, slug: string, name: string, table: MemberRow[]) => {
          await seedTenantWithMembers(slug, name, table);
        },
      );

      When('I GET /api/public/kid-members/khan', async () => {
        res = await app.request('/api/public/kid-members/khan');
        body = (await res.json()) as typeof body;
      });

      Then('the response status is 200', () => {
        expect(res.status).toBe(200);
      });

      And('the family name is {string}', (_ctx, name: string) => {
        expect(body.family.name).toBe(name);
      });

      And('the kids list has exactly {int} entries', (_ctx, n: number) => {
        expect(body.kids).toHaveLength(n);
      });

      And('the kids list in order is {string}', (_ctx, csv: string) => {
        expect(body.kids.map((k) => k.displayName).join(',')).toBe(csv);
      });
    },
  );

  Scenario('Unknown slug returns 404', ({ When, Then }) => {
    let res: Response;

    When('I GET /api/public/kid-members/no-such-family', async () => {
      res = await app.request('/api/public/kid-members/no-such-family');
    });

    Then('the response status is 404', () => {
      expect(res.status).toBe(404);
    });
  });

  Scenario(
    'Uppercase slug is normalised so iOS-autocapitalised links resolve',
    ({ Given, When, Then, And }) => {
      let res: Response;
      let body: { family: { name: string } };

      Given(
        'the tenant {string} named {string} has these members:',
        async (_ctx, slug: string, name: string, table: MemberRow[]) => {
          await seedTenantWithMembers(slug, name, table);
        },
      );

      When('I GET /api/public/kid-members/Khan', async () => {
        res = await app.request('/api/public/kid-members/Khan');
        body = (await res.json()) as typeof body;
      });

      Then('the response status is 200', () => {
        expect(res.status).toBe(200);
      });

      And('the family name is {string}', (_ctx, name: string) => {
        expect(body.family.name).toBe(name);
      });
    },
  );

  Scenario(
    'Tenant isolation — kids in another tenant are never returned',
    ({ Given, When, Then, And }) => {
      let res: Response;
      let body: { kids: { displayName: string }[] };

      Given(
        'the tenant {string} named {string} has these members:',
        async (_ctx, slug: string, name: string, table: MemberRow[]) => {
          await seedTenantWithMembers(slug, name, table);
        },
      );

      And(
        'the tenant {string} named {string} has these members:',
        async (_ctx, slug: string, name: string, table: MemberRow[]) => {
          await seedTenantWithMembers(slug, name, table);
        },
      );

      When('I GET /api/public/kid-members/khan', async () => {
        res = await app.request('/api/public/kid-members/khan');
        body = (await res.json()) as typeof body;
      });

      Then('the response status is 200', () => {
        expect(res.status).toBe(200);
      });

      And('the kids list has exactly {int} entries', (_ctx, n: number) => {
        expect(body.kids).toHaveLength(n);
      });

      And('the kids list in order is {string}', (_ctx, csv: string) => {
        expect(body.kids.map((k) => k.displayName).join(',')).toBe(csv);
      });
    },
  );
});
