import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { asRuntimeTenant, runtimeTestPool } from '@familyhub/test-utils';
import { authMiddleware, _resetJwksCacheForTests } from '../../../src/security/auth.js';
import { makeDbLookup, resolveTenant } from '../../../src/security/resolve-tenant.js';
import { requestDb } from '../../../src/security/request-db.js';
import { issueReportsRouter } from '../../../src/areas/feedback/issue-reports.js';
import { createFounderRouter, issueFounderToken } from '../../../src/areas/admin/founder.js';
import { _resetRateLimitForTests } from '../../../src/security/rate-limit.js';
import { tenants, members, users } from '../../../src/database/schema.js';
import type { Database } from '../../../src/database/client.js';
import { getTestDb } from '../support/db.js';

// FHS-717. The app is wired like production: the real family lookup from
// x-tenant-slug, the real per-request connection step (which the issue form
// skips) and the route's own short connections. Every one of those
// connections logs in as app_runtime, the limited role that cannot see past
// RLS, with the family pinned. Set-up and checks use the superuser connection.

vi.mock('../../../src/database/client.js', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const schema = await import('../../../src/database/schema.js');
  const utils = await import('@familyhub/test-utils');
  const als = new AsyncLocalStorage<unknown>();
  return {
    getDb: () => als.getStore() ?? utils.getTestDb(),
    runWithRequestDb: async (
      fn: () => Promise<unknown>,
      opts: { tenantId?: string | undefined } = {},
    ) => {
      if (als.getStore()) return fn();
      const client = await utils.runtimeTestPool().connect();
      try {
        await client.query("select set_config('app.current_tenant', $1, false)", [
          opts.tenantId ?? '',
        ]);
        return await als.run(drizzle(client, { schema }), fn);
      } finally {
        await client.query("select set_config('app.current_tenant', '', false)");
        client.release();
      }
    },
  };
});

const ISSUER = 'https://auth.test.local/auth/v1';
const KID = 'issue-reports-int-kid';
const PEOPLE = {
  Mum: { id: '00000000-0000-4000-8000-000000000a17', email: 'mum-issues@example.com' },
  Sam: { id: '00000000-0000-4000-8000-000000000b17', email: 'sam-issues@example.com' },
} as const;
type Person = keyof typeof PEOPLE;
const SECRETS = { passcode: '246810', secret: 'integration-test-secret-at-least-32-chars' };

const feature = await loadFeature(
  new URL('../features/issue-reports.feature', import.meta.url).pathname,
);

// Counts app-role connections handed out, to prove what is held when.
let acquired = 0;
let counting = false;
function watchPool() {
  if (counting) return;
  counting = true;
  runtimeTestPool().on('acquire', () => {
    acquired += 1;
  });
}
const inUse = () => runtimeTestPool().totalCount - runtimeTestPool().idleCount;

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

// 20 lines of 99 letters, 19 line breaks and one more letter: 2000 typed.
const TYPED_2000 = Array.from({ length: 20 }, () => 'a'.repeat(99)).join('\n') + 'b';

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

  async function headersFor(person: Person, slug: string) {
    return { Authorization: `Bearer ${await mintToken(person)}`, 'x-tenant-slug': slug };
  }

  async function send(person: Person, fd: FormData, slug = 'issues-alpha') {
    res = await app.request('/api/feedback/issues', {
      method: 'POST',
      headers: await headersFor(person, slug),
      body: fd,
    });
    if (res.status === 201) {
      lastId = ((await res.clone().json()) as { id: string }).id;
      reportIds.push(lastId);
    }
  }

  function formOf(description: string, screen: string, photos: File[] = []) {
    const fd = new FormData();
    fd.append('screen', screen);
    if (description) fd.append('description', description);
    for (const p of photos) fd.append('photos', p);
    return fd;
  }

  const report = (
    person: Person,
    description: string,
    screen: string,
    photos: File[] = [],
    slug = 'issues-alpha',
  ) => send(person, formOf(description, screen, photos), slug);

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

  async function savedDescription() {
    const r = await db.execute<{ description: string }>(
      sql`SELECT description FROM issue_reports WHERE id = ${lastId}`,
    );
    return r.rows[0]!.description;
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

  async function seedReports(slug: string, recent: number, older = 0) {
    await db.execute(
      sql`INSERT INTO issue_reports (tenant_id, screen, description, created_at)
          SELECT ${tenantIds[slug]!}, 'today', 'earlier ' || g, now() - make_interval(mins => g)
            FROM generate_series(1, ${recent}::int) g`,
    );
    if (older > 0) {
      await db.execute(
        sql`INSERT INTO issue_reports (tenant_id, screen, description, created_at)
            SELECT ${tenantIds[slug]!}, 'today', 'old ' || g, now() - interval '25 hours' - make_interval(mins => g)
              FROM generate_series(1, ${older}::int) g`,
      );
    }
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

  type Issue = {
    id: string;
    familyName: string;
    reporterName: string | null;
    reporterEmail: string | null;
    status: string;
    fixedAt: string | null;
    photos: Array<{ id: string; contentType: string; sizeBytes: number }>;
  };
  async function listIssues(): Promise<Issue[]> {
    const r = await founder('/issues');
    expect(r.status).toBe(200);
    return ((await r.json()) as { issues: Issue[] }).issues;
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
      watchPool();
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
      app.use(
        '/api/feedback/*',
        resolveTenant({ lookupTenantId: makeDbLookup(() => db), baseDomain: 'localhost' }),
      );
      app.use('/api/*', requestDb());
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
      let issues: Issue[] = [];
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
        issues = await listIssues();
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

  Scenario('A file under another field name is refused', ({ When, Then, And }) => {
    When(
      'Mum reports {string} on screen {string} with a photo in a field named {string}',
      async (_ctx, words: string, screen: string, field: string) => {
        const fd = formOf(words, screen);
        fd.append(field, asFile(png(), 'shot.png', 'image/png'));
        await send('Mum', fd);
      },
    );
    Then('the report answers {int}', async (_ctx, status: number) => {
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ errorCode: 'UNEXPECTED_FILE' });
    });
    And(
      'family {string} holds {int} issue report with {int} photos',
      async (_ctx, slug: string, reports: number, photos: number) => {
        expect(await countFor(slug)).toEqual({ reports, photos });
      },
    );
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

  Scenario('Line breaks count as one character each', ({ When, Then, And }) => {
    When(
      'Mum reports {int} typed characters with line breaks on screen {string}',
      async (_ctx, n: number, screen: string) => {
        expect(TYPED_2000).toHaveLength(n);
        // Real form data: each line break goes over the wire as CRLF.
        await report('Mum', TYPED_2000, screen);
      },
    );
    Then('the report answers 201 with an id', () => {
      expect(res.status).toBe(201);
    });
    And('the saved description is exactly what Mum typed', async () => {
      expect(await savedDescription()).toBe(TYPED_2000);
    });
  });

  Scenario('Hidden control characters never break a report', ({ When, Then, And }) => {
    When(
      'Mum reports words with a zero byte in them on screen {string}',
      async (_ctx, screen: string) => {
        await report('Mum', 'bro\u0000ken', screen);
      },
    );
    Then('the report answers 201 with an id', () => {
      expect(res.status).toBe(201);
    });
    And('the saved description is {string}', async (_ctx, text: string) => {
      expect(await savedDescription()).toBe(text);
    });
    When(
      'Mum reports {string} on a screen name with a zero byte in it',
      async (_ctx, words: string) => {
        await report('Mum', words, 'to\u0000day');
      },
    );
    Then('the report answers {int}', (_ctx, status: number) => {
      expect(res.status).toBe(status);
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

  Scenario('A grown-up cannot report into another family', ({ Given, When, Then, And }) => {
    Given('a second family {string} exists', async (_ctx, slug: string) => {
      await addFamily(slug);
    });
    When(
      'Mum reports {string} on screen {string} to family {string}',
      async (_ctx, words: string, screen: string, slug: string) => {
        await report('Mum', words, screen, pngs(1), slug);
      },
    );
    Then('the report answers {int}', async (_ctx, status: number) => {
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ errorCode: 'GROWN_UPS_ONLY' });
    });
    And(
      'family {string} holds {int} issue report with {int} photos',
      async (_ctx, slug: string, reports: number, photos: number) => {
        expect(await countFor(slug)).toEqual({ reports, photos });
      },
    );
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

  Scenario('A photo cannot sit in a different family from its report', ({ Given, And, Then }) => {
    Given('a second family {string} exists', async (_ctx, slug: string) => {
      await addFamily(slug);
    });
    And(
      'Mum has reported {string} on screen {string} with {int} PNG photo',
      async (_ctx, words: string, screen: string, n: number) => {
        await report('Mum', words, screen, pngs(n));
        expect(res.status).toBe(201);
      },
    );
    Then(
      'a photo of that report filed under {string} is refused by the database',
      async (_ctx, slug: string) => {
        // The superuser skips RLS, so only the database rule can stop this.
        await expect(
          db.execute(
            sql`INSERT INTO issue_report_photos (report_id, tenant_id, content_type, size_bytes, data)
                VALUES (${lastId}, ${tenantIds[slug]!}, 'image/png', 8, ${png(8)})`,
          ),
        ).rejects.toThrow(/issue_report_photos_report_family_fk/);
      },
    );
  });

  Scenario('A family can send 30 reports a day', ({ Given, When, Then, And }) => {
    Given(
      'family {string} already sent {int} reports in the last 24 hours',
      async (_ctx, slug: string, n: number) => {
        await seedReports(slug, n);
      },
    );
    When('Mum reports {string} on screen {string}', async (_ctx, words: string, screen: string) => {
      await report('Mum', words, screen);
    });
    Then('the report answers {int}', async (_ctx, status: number) => {
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ errorCode: 'FAMILY_DAILY_LIMIT' });
    });
    And(
      'family {string} holds {int} issue report with {int} photos',
      async (_ctx, slug: string, reports: number, photos: number) => {
        expect(await countFor(slug)).toEqual({ reports, photos });
      },
    );
  });

  Scenario('Reports older than 24 hours do not count', ({ Given, When, Then }) => {
    Given(
      'family {string} already sent {int} reports in the last 24 hours and {int} before that',
      async (_ctx, slug: string, recent: number, older: number) => {
        await seedReports(slug, recent, older);
      },
    );
    When('Mum reports {string} on screen {string}', async (_ctx, words: string, screen: string) => {
      await report('Mum', words, screen);
    });
    Then('the report answers 201 with an id', () => {
      expect(res.status).toBe(201);
    });
  });

  Scenario('A slow upload holds no database connection', ({ When, Then, And }) => {
    let finish!: () => void;
    let slow: Promise<Response>;
    let before = 0;
    When('Mum starts a report with a photo and the upload stalls', async () => {
      const r = new Response(formOf('slow phone', 'today', pngs(1)));
      const type = r.headers.get('content-type')!;
      const bytes = new Uint8Array(await r.arrayBuffer());
      const rest = new Promise<void>((resolve) => (finish = resolve));
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(bytes.slice(0, 64));
          await rest;
          controller.enqueue(bytes.slice(64));
          controller.close();
        },
      });
      before = acquired;
      slow = app.request('/api/feedback/issues', {
        method: 'POST',
        headers: { ...(await headersFor('Mum', 'issues-alpha')), 'Content-Type': type },
        body,
        // @ts-expect-error duplex is needed for a streamed body in Node.
        duplex: 'half',
      });
    });
    Then('no app database connection is in use', async () => {
      // The grown-up check borrowed one connection and gave it back...
      await vi.waitFor(() => {
        expect(acquired - before).toBe(1);
        expect(inUse()).toBe(0);
      });
      // ...and nothing else is borrowed while the upload is stuck.
      await new Promise((r) => setTimeout(r, 100));
      expect(acquired - before).toBe(1);
      expect(inUse()).toBe(0);
    });
    And('the founder can still list the issue reports', async () => {
      expect(await listIssues()).toEqual([]);
    });
    When('the rest of the upload arrives', () => {
      finish();
    });
    Then('the slow report answers 201', async () => {
      expect((await slow).status).toBe(201);
      expect(await countFor('issues-alpha')).toEqual({ reports: 1, photos: 1 });
      expect(inUse()).toBe(0);
    });
  });

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
      const issues = await listIssues();
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

  Scenario('Old new reports stay on the founder list', ({ Given, When, Then }) => {
    let oldId = '';
    let issues: Issue[] = [];
    Given(
      'family {string} has an unfixed report from 30 days ago and {int} newer fixed reports',
      async (_ctx, slug: string, fixed: number) => {
        const old = await db.execute<{ id: string }>(
          sql`INSERT INTO issue_reports (tenant_id, screen, description, created_at)
              VALUES (${tenantIds[slug]!}, 'today', 'old and unfixed', now() - interval '30 days')
              RETURNING id`,
        );
        oldId = old.rows[0]!.id;
        await db.execute(
          sql`INSERT INTO issue_reports (tenant_id, screen, description, status, fixed_at, created_at)
              SELECT ${tenantIds[slug]!}, 'today', 'fixed ' || g, 'fixed', now(), now() - make_interval(mins => g)
                FROM generate_series(1, ${fixed}::int) g`,
        );
      },
    );
    When('the founder lists the issue reports', async () => {
      issues = await listIssues();
    });
    Then('the list holds the old unfixed report and the newest 500 fixed ones', () => {
      expect(issues).toHaveLength(501);
      expect(issues.filter((i) => i.status === 'fixed')).toHaveLength(500);
      // Newest first, so the 30-day-old report comes last.
      expect(issues[500]).toMatchObject({ id: oldId, status: 'new' });
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
