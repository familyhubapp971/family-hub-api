import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { expect, vi } from 'vitest';
import { asRuntimeTenant, runtimeTestPool } from '@familyhub/test-utils';
import { authMiddleware, _resetJwksCacheForTests } from '../../../src/security/auth.js';
import { issueReportsRouter } from '../../../src/areas/feedback/issue-reports.js';
import { createFounderRouter, issueFounderToken } from '../../../src/areas/admin/founder.js';
import { _resetRateLimitForTests } from '../../../src/security/rate-limit.js';
import * as schema from '../../../src/database/schema.js';
import { tenants, members, users } from '../../../src/database/schema.js';
import type { Database } from '../../../src/database/client.js';
import { getTestDb } from '../support/db.js';

// FHS-717. Requests run on an app_runtime connection (the limited role that
// cannot see past RLS), with the family pinned the way the request middleware
// pins it in production. Set-up and checks use the superuser test connection.

const ISSUER = 'https://auth.test.local/auth/v1';
const KID = 'issue-reports-int-kid';
const PEOPLE = {
  Mum: { id: '00000000-0000-4000-8000-000000000a17', email: 'mum-issues@example.com' },
  Sam: { id: '00000000-0000-4000-8000-000000000b17', email: 'sam-issues@example.com' },
} as const;
type Person = keyof typeof PEOPLE;
const SECRETS = { passcode: '246810', secret: 'integration-test-secret-at-least-32-chars' };

const state = vi.hoisted(() => ({ requestDb: undefined as unknown }));
vi.mock('../../../src/database/client.js', () => ({
  getDb: () => state.requestDb ?? getTestDb(),
}));

const feature = await loadFeature(
  new URL('../features/issue-reports.feature', import.meta.url).pathname,
);

// The limited role, with the family from x-test-tenant pinned (or none, as
// for the founder routes), for exactly one request.
const asAppRole: MiddlewareHandler = async (c, next) => {
  const client = await runtimeTestPool().connect();
  try {
    await client.query("select set_config('app.current_tenant', $1, false)", [
      c.req.header('x-test-tenant') ?? '',
    ]);
    state.requestDb = drizzle(client, { schema });
    await next();
  } finally {
    state.requestDb = undefined;
    await client.query("select set_config('app.current_tenant', '', false)");
    client.release();
  }
};

const tenantFromHeader: MiddlewareHandler = async (c, next) => {
  c.set('tenantId', c.req.header('x-test-tenant'));
  await next();
};

// Small stand-ins: only the first bytes decide the type.
function png(size = 2048): Buffer {
  const b = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  for (let i = 8; i < size; i++) b[i] = (i * 31) % 256;
  return b;
}
function jpeg(size = 2048): Buffer {
  const b = Buffer.alloc(size, 9);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(b);
  return b;
}
const asFile = (bytes: Buffer, name: string, type: string) =>
  new File([new Uint8Array(bytes)], name, { type });

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let privateKey: KeyLike;
  let res: Response;
  let lastId = '';
  const reportIds: string[] = [];
  const tenantIds: Record<string, string> = {};
  const founderToken = () => issueFounderToken(SECRETS);

  async function genKey() {
    const keys = await generateKeyPair('ES256', { extractable: true });
    const publicJwk = await exportJWK(keys.publicKey);
    publicJwk.alg = 'ES256';
    publicJwk.kid = KID;
    publicJwk.use = 'sig';
    return { privateKey: keys.privateKey, publicJwk };
  }

  function makeJwks(publicJwk: JWK) {
    return async (header: { kid?: string; alg?: string }) => {
      const { importJWK } = await import('jose');
      if (header.kid !== publicJwk.kid) throw new Error(`no key for kid ${header.kid}`);
      return (await importJWK(publicJwk, header.alg ?? 'ES256')) as KeyLike;
    };
  }

  function mintToken(person: Person) {
    return new SignJWT({ email: PEOPLE[person].email })
      .setProtectedHeader({ alg: 'ES256', kid: KID })
      .setSubject(PEOPLE[person].id)
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);
  }

  async function addFamily(slug: string) {
    const [t] = await db
      .insert(tenants)
      .values({ slug, name: `${slug} Family` })
      .returning();
    tenantIds[slug] = t!.id;
    return t!.id;
  }

  async function addPerson(person: Person, slug: string, role: 'adult' | 'child') {
    const { id, email } = PEOPLE[person];
    await db.execute(
      sql`INSERT INTO users (id, email) VALUES (${id}, ${email})
          ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
    );
    await db.insert(members).values({
      tenantId: tenantIds[slug] ?? (await addFamily(slug)),
      userId: id,
      displayName: person,
      role,
      isChild: role === 'child',
    });
  }

  async function report(
    person: Person,
    description: string,
    screen: string,
    photos: File[] = [],
    slug = 'issues-alpha',
  ) {
    const fd = new FormData();
    fd.append('screen', screen);
    if (description) fd.append('description', description);
    for (const p of photos) fd.append('photos', p);
    res = await app.request('/api/feedback/issues', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await mintToken(person)}`,
        'x-test-tenant': tenantIds[slug]!,
      },
      body: fd,
    });
    if (res.status === 201) {
      lastId = ((await res.clone().json()) as { id: string }).id;
      reportIds.push(lastId);
    }
  }

  const pngs = (n: number) =>
    Array.from({ length: n }, (_, i) => asFile(png(), `p${i}.png`, 'image/png'));
  const jpegs = (n: number) =>
    Array.from({ length: n }, (_, i) => asFile(jpeg(), `p${i}.jpg`, 'image/jpeg'));

  async function countFor(slug: string) {
    const r = await db.execute<{ reports: number; photos: number }>(
      sql`SELECT (SELECT count(*)::int FROM issue_reports WHERE tenant_id = ${tenantIds[slug]!}) AS reports,
                 (SELECT count(*)::int FROM issue_report_photos WHERE tenant_id = ${tenantIds[slug]!}) AS photos`,
    );
    return r.rows[0]!;
  }

  async function asFamily(slug: string) {
    return asRuntimeTenant(tenantIds[slug]!, async (c) => {
      const r = await c.query<{ reports: number; photos: number }>(
        `SELECT (SELECT count(*)::int FROM issue_reports) AS reports,
                (SELECT count(*)::int FROM issue_report_photos) AS photos`,
      );
      return r.rows[0]!;
    });
  }

  function founder(path: string, init: RequestInit = {}, token: string | null = founderToken()) {
    return app.request(`/api/founder${path}`, {
      ...init,
      headers: { ...(token ? { 'x-founder-token': token } : {}), ...(init.headers ?? {}) },
    });
  }

  async function markReport(id: string, status: string) {
    res = await founder(`/issues/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
  }

  Background(({ Given, And }) => {
    Given('the issue report test DB is clean', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(
        sql`TRUNCATE TABLE issue_report_photos, issue_reports RESTART IDENTITY CASCADE`,
      );
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${PEOPLE.Mum.id}, ${PEOPLE.Sam.id})`);
      _resetJwksCacheForTests();
      _resetRateLimitForTests();
      for (const k of Object.keys(tenantIds)) delete tenantIds[k];
      reportIds.length = 0;
      lastId = '';

      const keys = await genKey();
      privateKey = keys.privateKey;
      app = new Hono();
      app.use(
        '/api/feedback/*',
        authMiddleware({
          issuer: ISSUER,
          jwks: makeJwks(keys.publicJwk),
          userMirrorSync: async (claims) => {
            const rows = await db
              .select()
              .from(users)
              .where(sql`id = ${claims.id}`)
              .limit(1);
            return rows[0]!;
          },
        }),
      );
      app.use('/api/feedback/*', tenantFromHeader);
      app.use('*', asAppRole);
      app.route('/api/feedback/issues', issueReportsRouter);
      app.route(
        '/api/founder',
        createFounderRouter(() => SECRETS),
      );
    });

    And(
      'a grown-up {string} is an adult in family {string}',
      async (_ctx, person: Person, slug: string) => {
        await addFamily(slug);
        await addPerson(person, slug, 'adult');
      },
    );
  });

  Scenario('A grown-up reports a problem in words', ({ When, Then, And }) => {
    When('Mum reports {string} on screen {string}', async (_ctx, words: string, screen: string) => {
      await report('Mum', words, screen);
    });
    Then('the report answers 201 with an id', () => {
      expect(res.status).toBe(201);
      expect(lastId).toMatch(/^[0-9a-f-]{36}$/);
    });
    And(
      'family {string} holds {int} issue report with {int} photos',
      async (_ctx, slug: string, reports: number, photos: number) => {
        expect(await countFor(slug)).toEqual({ reports, photos });
        const r = await db.execute<{ description: string; member: string | null }>(
          sql`SELECT description, submitted_by_member_id AS member FROM issue_reports`,
        );
        expect(r.rows[0]!.description).toBe('The save button does nothing');
        expect(r.rows[0]!.member).not.toBeNull();
      },
    );
  });

  Scenario(
    'A grown-up reports a problem with a photo and the founder sees it',
    ({ When, Then, And }) => {
      let photo: Buffer;
      let issues: Array<{
        id: string;
        familyName: string;
        reporterName: string | null;
        reporterEmail: string | null;
        status: string;
        photos: Array<{ id: string; contentType: string; sizeBytes: number }>;
      }> = [];
      When(
        'Mum reports {string} on screen {string} with {int} PNG photo',
        async (_ctx, words: string, screen: string) => {
          photo = png(4096);
          await report('Mum', words, screen, [asFile(photo, 'shot.jpg', 'image/jpeg')]);
        },
      );
      Then('the report answers 201 with an id', () => {
        expect(res.status).toBe(201);
      });
      When('the founder lists the issue reports', async () => {
        res = await founder('/issues');
        expect(res.status).toBe(200);
        issues = ((await res.json()) as { issues: typeof issues }).issues;
      });
      Then(
        'the founder sees the report from {string} by {string} with {int} photo',
        (_ctx, family: string, name: string, count: number) => {
          expect(issues).toHaveLength(1);
          expect(issues[0]).toMatchObject({
            id: lastId,
            familyName: family,
            reporterName: name,
            reporterEmail: PEOPLE.Mum.email,
            status: 'new',
          });
          expect(issues[0]!.photos).toHaveLength(count);
          expect(issues[0]!.photos[0]).toMatchObject({ contentType: 'image/png', sizeBytes: 4096 });
        },
      );
      And(
        'the founder gets the photo back byte for byte as {string}',
        async (_ctx, type: string) => {
          const r = await founder(`/issues/${lastId}/photos/${issues[0]!.photos[0]!.id}`);
          expect(r.status).toBe(200);
          expect(r.headers.get('content-type')).toBe(type);
          expect(r.headers.get('cache-control')).toBe('private, no-store');
          expect(r.headers.get('x-content-type-options')).toBe('nosniff');
          expect(r.headers.get('content-disposition')).toBe('inline');
          expect(Buffer.compare(Buffer.from(await r.arrayBuffer()), photo)).toBe(0);
        },
      );
    },
  );

  Scenario('A photo with no words is accepted', ({ When, Then, And }) => {
    When(
      'Mum reports {string} on screen {string} with {int} JPEG photo',
      async (_ctx, words: string, screen: string, n: number) => {
        await report('Mum', words, screen, jpegs(n));
      },
    );
    Then('the report answers 201 with an id', () => {
      expect(res.status).toBe(201);
    });
    And(
      'family {string} holds {int} issue report with {int} photos',
      async (_ctx, slug: string, reports: number, photos: number) => {
        expect(await countFor(slug)).toEqual({ reports, photos });
      },
    );
  });

  Scenario('An empty report is refused', ({ When, Then }) => {
    When('Mum reports {string} on screen {string}', async (_ctx, words: string, screen: string) => {
      await report('Mum', words, screen);
    });
    Then('the report answers {int}', (_ctx, status: number) => {
      expect(res.status).toBe(status);
    });
  });

  Scenario('A fourth photo is refused', ({ When, Then, And }) => {
    When(
      'Mum reports {string} on screen {string} with {int} JPEG photos',
      async (_ctx, words: string, screen: string, n: number) => {
        await report('Mum', words, screen, jpegs(n));
      },
    );
    Then('the report answers {int}', (_ctx, status: number) => {
      expect(res.status).toBe(status);
    });
    And(
      'family {string} holds {int} issue report with {int} photos',
      async (_ctx, slug: string, reports: number, photos: number) => {
        expect(await countFor(slug)).toEqual({ reports, photos });
      },
    );
  });

  Scenario('A text file named like a photo is refused', ({ When, Then }) => {
    When(
      'Mum reports {string} on screen {string} with a text file named {string}',
      async (_ctx, words: string, screen: string, name: string) => {
        const text = Buffer.from('this is plain text pretending to be a photo');
        await report('Mum', words, screen, [asFile(text, name, 'image/jpeg')]);
      },
    );
    Then('the report answers {int}', async (_ctx, status: number) => {
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ errorCode: 'PHOTO_TYPE' });
    });
  });

  Scenario('A photo over 1 MB is refused', ({ When, Then }) => {
    When(
      'Mum reports {string} on screen {string} with a 1.2 MB JPEG photo',
      async (_ctx, words: string, screen: string) => {
        const big = jpeg(Math.round(1.2 * 1024 * 1024));
        await report('Mum', words, screen, [asFile(big, 'big.jpg', 'image/jpeg')]);
      },
    );
    Then('the report answers {int}', async (_ctx, status: number) => {
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ errorCode: 'PHOTO_TOO_LARGE' });
      expect(await countFor('issues-alpha')).toEqual({ reports: 0, photos: 0 });
    });
  });

  Scenario('A request over 3.5 MB is refused', ({ When, Then }) => {
    When(
      'Mum reports {string} on screen {string} with {int} photos of 1.2 MB',
      async (_ctx, words: string, screen: string, n: number) => {
        const files = Array.from({ length: n }, (_, i) =>
          asFile(jpeg(Math.round(1.2 * 1024 * 1024)), `big${i}.jpg`, 'image/jpeg'),
        );
        await report('Mum', words, screen, files);
      },
    );
    Then('the report answers {int}', async (_ctx, status: number) => {
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({
        error: 'request too large',
        errorCode: 'PAYLOAD_TOO_LARGE',
      });
    });
  });

  Scenario('A child cannot report', ({ Given, When, Then }) => {
    Given(
      'a child {string} with a sign-in is in family {string}',
      async (_ctx, person: Person, slug: string) => {
        await addPerson(person, slug, 'child');
      },
    );
    When('Sam reports {string} on screen {string}', async (_ctx, words: string, screen: string) => {
      await report('Sam', words, screen);
    });
    Then('the report answers {int}', async (_ctx, status: number) => {
      expect(res.status).toBe(status);
      expect(await countFor('issues-alpha')).toEqual({ reports: 0, photos: 0 });
    });
  });

  Scenario(
    "Tenant isolation: family B cannot read family A's reports",
    ({ Given, When, Then, And }) => {
      Given('a second family {string} exists', async (_ctx, slug: string) => {
        await addFamily(slug);
      });
      When(
        'Mum reports {string} on screen {string} with {int} PNG photo',
        async (_ctx, words: string, screen: string, n: number) => {
          await report('Mum', words, screen, pngs(n));
          expect(res.status).toBe(201);
        },
      );
      Then(
        'the app role pinned to {string} sees {int} issue reports and {int} photos',
        async (_ctx, slug: string, reports: number, photos: number) => {
          expect(await asFamily(slug)).toEqual({ reports, photos });
        },
      );
      And(
        'the app role pinned to {string} sees {int} issue reports and {int} photos',
        async (_ctx, slug: string, reports: number, photos: number) => {
          expect(await asFamily(slug)).toEqual({ reports, photos });
        },
      );
      And(
        'the app role pinned to {string} cannot add a report for {string}',
        async (_ctx, pinned: string, target: string) => {
          await expect(
            asRuntimeTenant(tenantIds[pinned]!, (c) =>
              c.query(
                `INSERT INTO issue_reports (tenant_id, screen, description) VALUES ($1, 'today', 'x')`,
                [tenantIds[target]!],
              ),
            ),
          ).rejects.toThrow(/row-level security/);
        },
      );
    },
  );

  Scenario('Founder issue routes need the page token', ({ Given, When, Then }) => {
    let statuses: number[] = [];
    Given(
      'Mum has reported {string} on screen {string} with {int} PNG photo',
      async (_ctx, words: string, screen: string, n: number) => {
        await report('Mum', words, screen, pngs(n));
        expect(res.status).toBe(201);
      },
    );
    When('someone calls the three founder issue routes without a token', async () => {
      const photo = await db.execute<{ id: string }>(sql`SELECT id FROM issue_report_photos`);
      // One at a time: each request borrows the one app-role connection slot.
      const list = await founder('/issues', {}, null);
      const image = await founder(`/issues/${lastId}/photos/${photo.rows[0]!.id}`, {}, null);
      const mark = await founder(
        `/issues/${lastId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'fixed' }),
        },
        null,
      );
      statuses = [list.status, image.status, mark.status];
    });
    Then('all three answer 401', async () => {
      expect(statuses).toEqual([401, 401, 401]);
      const r = await db.execute<{ status: string }>(sql`SELECT status FROM issue_reports`);
      expect(r.rows[0]!.status).toBe('new');
    });
  });

  Scenario('The founder marks a report fixed, then reopens it', ({ Given, When, Then, And }) => {
    Given(
      'Mum has reported {string} on screen {string} with {int} PNG photo',
      async (_ctx, words: string, screen: string, n: number) => {
        await report('Mum', words, screen, pngs(n));
        expect(res.status).toBe(201);
      },
    );
    When('the founder marks the report {string}', async (_ctx, status: string) => {
      await markReport(lastId, status);
    });
    Then('the report is {string} with a fixed time', async (_ctx, status: string) => {
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; status: string; fixedAt: string | null };
      expect(body.id).toBe(lastId);
      expect(body.status).toBe(status);
      expect(Date.parse(body.fixedAt ?? '')).not.toBeNaN();
    });
    And('the founder list shows it as {string}', async (_ctx, status: string) => {
      const r = await founder('/issues');
      const { issues } = (await r.json()) as {
        issues: Array<{ status: string; fixedAt: string | null }>;
      };
      expect(issues[0]!.status).toBe(status);
      expect(issues[0]!.fixedAt).not.toBeNull();
    });
    When('the founder reopens the report', async () => {
      await markReport(lastId, 'new');
    });
    Then('the report is {string} with no fixed time', async (_ctx, status: string) => {
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: lastId, status, fixedAt: null });
    });
  });

  Scenario('Marking an unknown report is not found', ({ When, Then }) => {
    When(
      'the founder marks a report that does not exist {string}',
      async (_ctx, status: string) => {
        await markReport('99999999-9999-4999-8999-999999999999', status);
      },
    );
    Then('the founder issue API answers {int}', (_ctx, status: number) => {
      expect(res.status).toBe(status);
    });
  });

  Scenario(
    'A photo asked for under a different report is not found',
    ({ Given, And, When, Then }) => {
      Given(
        'Mum has reported {string} on screen {string} with {int} PNG photo',
        async (_ctx, words: string, screen: string, n: number) => {
          await report('Mum', words, screen, pngs(n));
          expect(res.status).toBe(201);
        },
      );
      And(
        'Mum has reported {string} on screen {string} with {int} PNG photo',
        async (_ctx, words: string, screen: string, n: number) => {
          await report('Mum', words, screen, pngs(n));
          expect(res.status).toBe(201);
        },
      );
      When("the founder asks for the first report's photo under the second report", async () => {
        const [first, second] = reportIds;
        const photo = await db.execute<{ id: string }>(
          sql`SELECT id FROM issue_report_photos WHERE report_id = ${first!}`,
        );
        // The photo is real and reachable under its own report...
        const own = await founder(`/issues/${first!}/photos/${photo.rows[0]!.id}`);
        expect(own.status).toBe(200);
        res = await founder(`/issues/${second!}/photos/${photo.rows[0]!.id}`);
      });
      Then('the founder issue API answers {int}', (_ctx, status: number) => {
        expect(res.status).toBe(status);
      });
    },
  );
});
