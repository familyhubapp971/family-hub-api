/**
 * Step bindings for calendar-feed.feature (FHS-445).
 *
 * Covers GET /api/calendar/feed, POST /api/calendar/feed/rotate (both authed,
 * tenant-scoped, rotate is admin-only), and the public ICS endpoint the
 * returned url points at (GET /api/public/calendar/:token — no auth, the
 * signed token in the path IS the credential). Proves:
 *   - a member can fetch the url and the public feed lists that family's
 *     events as SUMMARY lines,
 *   - tenant isolation — one family's feed never includes another's events,
 *   - a forged signature or a malformed token both 404 without leaking which
 *     case it was,
 *   - rotating the key 404s every previously issued url and the new url works,
 *   - rotate is admin-only.
 */

import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { calendarRouter } from '../../../apps/api/src/routes/calendar.js';
import { publicCalendarRouter } from '../../../apps/api/src/routes/public-calendar.js';
import { tenants, members, events, users } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

// The calendar routers call getDb()/pinRequestTenant() directly (not through
// the request-scoped AsyncLocalStorage plumbing) — mock both to the real test
// Postgres pool, same pattern as public-kid-members.steps.ts. Pin is a no-op:
// tests run as the superuser, which bypasses RLS.
vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
  pinRequestTenant: async () => {},
}));

const feature = await loadFeature(
  new URL('../features/calendar-feed.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'calendar-feed-int-kid';
const USER_ID = '00000000-0000-4000-8000-000000000445';
const USER_EMAIL = 'calendarfeed@example.com';
const GUEST_USER_ID = '00000000-0000-4000-8000-000000004452';
const GUEST_USER_EMAIL = 'guestcalendarfeed@example.com';

async function genKey() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = 'ES256';
  publicJwk.kid = KID;
  publicJwk.use = 'sig';
  return { privateKey, publicJwk };
}

async function mintToken(privateKey: KeyLike, userId: string, email: string) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(privateKey);
}

function makeJwks(publicJwk: JWK) {
  return async (header: { kid?: string; alg?: string }) => {
    const { importJWK } = await import('jose');
    if (header.kid !== publicJwk.kid) throw new Error(`no key for kid ${header.kid}`);
    return (await importJWK(publicJwk, header.alg ?? 'ES256')) as KeyLike;
  };
}

const resolveTenantFromHeader: MiddlewareHandler = async (c, next) => {
  c.set('tenantId', c.req.header('x-test-tenant'));
  await next();
};

// Split a subscribe url's own token out so a scenario can build a forged
// variant. The router accepts an optional trailing `.ics`.
function tokenPathFromUrl(url: string): { tenantId: string; sig: string; ics: boolean } {
  const path = new URL(url).pathname; // /api/public/calendar/<tenantId>.<sig>[.ics]
  const raw = path.slice('/api/public/calendar/'.length);
  const ics = raw.endsWith('.ics');
  const token = ics ? raw.slice(0, -4) : raw;
  const dot = token.indexOf('.');
  return { tenantId: token.slice(0, dot), sig: token.slice(dot + 1), ics };
}

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let token: string;
  let guestToken: string;
  const tenantIds: Record<string, string> = {};

  // The most recently issued subscribe url (from a GET /feed or a rotate),
  // and a snapshot taken right before a rotate — so a scenario can assert
  // the OLD url stops working while the NEW one starts working.
  let currentUrl: string;
  let preRotationUrl: string;

  let feedRes: Response;
  let rotateRes: Response;
  let publicRes: Response;
  let publicBody: string;

  // ─── Background ───────────────────────────────────────────────────────────

  Background(({ Given, And }) => {
    Given('the test Postgres has clean calendar-feed tables', async () => {
      db = getTestDb() as unknown as Database;
      await db.execute(sql`TRUNCATE TABLE events RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      await db.execute(sql`DELETE FROM users WHERE id IN (${USER_ID}, ${GUEST_USER_ID})`);
      _resetJwksCacheForTests();
      for (const k of Object.keys(tenantIds)) delete tenantIds[k];
    });

    And('a users mirror row exists for the calendar-feed test caller', async () => {
      await db.execute(
        sql`INSERT INTO users (id, email) VALUES (${USER_ID}, ${USER_EMAIL})
            ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      );
      await db.execute(
        sql`INSERT INTO users (id, email) VALUES (${GUEST_USER_ID}, ${GUEST_USER_EMAIL})
            ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      );
      const { privateKey, publicJwk } = await genKey();
      app = new Hono();
      app.use(
        '*',
        authMiddleware({
          issuer: ISSUER,
          jwks: makeJwks(publicJwk),
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
      app.use('*', resolveTenantFromHeader);
      app.route('/api/calendar', calendarRouter);
      // FHS-445 — no-auth public feed; skipped by authMiddleware via
      // PUBLIC_PATH_PREFIXES ('/api/public/calendar').
      app.route('/api/public/calendar', publicCalendarRouter);
      token = await mintToken(privateKey, USER_ID, USER_EMAIL);
      guestToken = await mintToken(privateKey, GUEST_USER_ID, GUEST_USER_EMAIL);
    });

    And('a tenant {string} exists with the caller as an admin member', async (_c, slug: string) => {
      const [tenant] = await db
        .insert(tenants)
        .values({ slug, name: `${slug} Family` })
        .returning();
      tenantIds[slug] = tenant!.id;
      await db
        .insert(members)
        .values({ tenantId: tenant!.id, userId: USER_ID, displayName: 'Caller', role: 'admin' });
    });
  });

  // ─── Shared helpers ─────────────────────────────────────────────────────

  function authHeaders(slug: string, forUserId = USER_ID) {
    const t = forUserId === GUEST_USER_ID ? guestToken : token;
    return { Authorization: `Bearer ${t}`, 'x-test-tenant': tenantIds[slug]! };
  }

  async function fetchPublicUrl(url: string): Promise<{ res: Response; body: string }> {
    const res = await app.request(new URL(url).pathname);
    const body = await res.text();
    return { res, body };
  }

  // ─── Scenario: member fetches url, public feed lists events ─────────────

  Scenario(
    'A member fetches the subscribe url and the public feed lists their events',
    ({ Given, When, Then, And }) => {
      Given(
        'the {string} tenant has an event {string} on {string}',
        async (_c, slug, title, date) => {
          await db.insert(events).values({ tenantId: tenantIds[slug]!, date, title });
        },
      );

      And(
        'the {string} tenant has an event {string} on {string}',
        async (_c, slug, title, date) => {
          await db.insert(events).values({ tenantId: tenantIds[slug]!, date, title });
        },
      );

      When('the caller GETs /api/calendar/feed for tenant {string}', async (_c, slug: string) => {
        feedRes = await app.request('/api/calendar/feed', { headers: authHeaders(slug) });
        if (feedRes.status === 200) {
          currentUrl = ((await feedRes.clone().json()) as { url: string }).url;
        }
      });

      Then('the feed response status is {int}', (_c, n: number) => {
        expect(feedRes.status).toBe(n);
      });

      When('an anonymous request fetches that subscribe url', async () => {
        const out = await fetchPublicUrl(currentUrl);
        publicRes = out.res;
        publicBody = out.body;
      });

      Then('the public feed response status is {int}', (_c, n: number) => {
        expect(publicRes.status).toBe(n);
      });

      And('the public feed content type is {string}', (_c, ct: string) => {
        expect(publicRes.headers.get('content-type') ?? '').toContain(ct);
      });

      And('the public feed body includes a {string} SUMMARY line', (_c, title: string) => {
        expect(publicBody).toContain(`SUMMARY:${title}`);
      });

      // A second "includes a ... SUMMARY line" check under the same "And"
      // keyword needs its OWN literal step text — @amiceli/vitest-cucumber
      // resolves a binding to the FIRST parsed step matching (type, text),
      // so two identical (keyword, text) bindings both bind to the SAME
      // parsed step and the second Gherkin line is left unmatched. Same
      // "separately"-style workaround events.steps.ts uses for its tenant-
      // isolation scenario.
      And('the public feed body also includes a {string} SUMMARY line', (_c, title: string) => {
        expect(publicBody).toContain(`SUMMARY:${title}`);
      });
    },
  );

  // ─── Scenario: tenant isolation ───────────────────────────────────────────

  Scenario(
    "Tenant isolation — a family's feed never includes another family's events",
    ({ Given, And, When, Then }) => {
      Given(
        'a second tenant {string} exists with the caller as an admin member',
        async (_c, slug: string) => {
          const [tenant] = await db
            .insert(tenants)
            .values({ slug, name: `${slug} Family` })
            .returning();
          tenantIds[slug] = tenant!.id;
          await db.insert(members).values({
            tenantId: tenant!.id,
            userId: USER_ID,
            displayName: 'Caller',
            role: 'admin',
          });
        },
      );

      And(
        'the {string} tenant has an event {string} on {string}',
        async (_c, slug, title, date) => {
          await db.insert(events).values({ tenantId: tenantIds[slug]!, date, title });
        },
      );

      // Same-pattern trick as events.steps.ts — a second "And ... has an
      // event ..." line needs its own literal text ("separately") so it
      // resolves to the SECOND parsed step, not the first (see the note in
      // the previous scenario).
      And(
        'separately the {string} tenant has an event {string} on {string}',
        async (_c, slug, title, date) => {
          await db.insert(events).values({ tenantId: tenantIds[slug]!, date, title });
        },
      );

      When('the caller GETs /api/calendar/feed for tenant {string}', async (_c, slug: string) => {
        feedRes = await app.request('/api/calendar/feed', { headers: authHeaders(slug) });
        if (feedRes.status === 200) {
          currentUrl = ((await feedRes.clone().json()) as { url: string }).url;
        }
      });

      Then('the feed response status is {int}', (_c, n: number) => {
        expect(feedRes.status).toBe(n);
      });

      When('an anonymous request fetches that subscribe url', async () => {
        const out = await fetchPublicUrl(currentUrl);
        publicRes = out.res;
        publicBody = out.body;
      });

      Then('the public feed response status is {int}', (_c, n: number) => {
        expect(publicRes.status).toBe(n);
      });

      And('the public feed body includes a {string} SUMMARY line', (_c, title: string) => {
        expect(publicBody).toContain(`SUMMARY:${title}`);
      });

      And('the public feed body excludes a {string} SUMMARY line', (_c, title: string) => {
        expect(publicBody).not.toContain(`SUMMARY:${title}`);
      });
    },
  );

  // ─── Scenario: forged signature ───────────────────────────────────────────

  Scenario('A forged signature on a real tenant id returns 404', ({ Given, When, Then }) => {
    Given(
      'the {string} tenant has an event {string} on {string}',
      async (_c, slug, title, date) => {
        await db.insert(events).values({ tenantId: tenantIds[slug]!, date, title });
      },
    );

    When('the caller GETs /api/calendar/feed for tenant {string}', async (_c, slug: string) => {
      feedRes = await app.request('/api/calendar/feed', { headers: authHeaders(slug) });
      if (feedRes.status === 200) {
        currentUrl = ((await feedRes.clone().json()) as { url: string }).url;
      }
    });

    Then('the feed response status is {int}', (_c, n: number) => {
      expect(feedRes.status).toBe(n);
    });

    When(
      'an anonymous request fetches that subscribe url with the signature replaced by {string}',
      async (_c, fakeSig: string) => {
        const { tenantId } = tokenPathFromUrl(currentUrl);
        publicRes = await app.request(`/api/public/calendar/${tenantId}.${fakeSig}`);
        publicBody = await publicRes.text();
      },
    );

    Then('the public feed response status is {int}', (_c, n: number) => {
      expect(publicRes.status).toBe(n);
    });
  });

  // ─── Scenario: malformed token ─────────────────────────────────────────────

  Scenario('A malformed token returns 404', ({ When, Then }) => {
    When(
      'an anonymous request fetches the public calendar feed at token {string}',
      async (_c, badToken: string) => {
        publicRes = await app.request(`/api/public/calendar/${badToken}`);
        publicBody = await publicRes.text();
      },
    );

    Then('the public feed response status is {int}', (_c, n: number) => {
      expect(publicRes.status).toBe(n);
    });
  });

  // ─── Scenario: rotate invalidates old url ─────────────────────────────────

  Scenario(
    'Rotating the feed key invalidates the old url and issues a working new one',
    ({ Given, When, Then }) => {
      Given(
        'the {string} tenant has an event {string} on {string}',
        async (_c, slug, title, date) => {
          await db.insert(events).values({ tenantId: tenantIds[slug]!, date, title });
        },
      );

      When('the caller GETs /api/calendar/feed for tenant {string}', async (_c, slug: string) => {
        feedRes = await app.request('/api/calendar/feed', { headers: authHeaders(slug) });
        if (feedRes.status === 200) {
          currentUrl = ((await feedRes.clone().json()) as { url: string }).url;
        }
      });

      Then('the feed response status is {int}', (_c, n: number) => {
        expect(feedRes.status).toBe(n);
      });

      When(
        'the caller POSTs /api/calendar/feed/rotate for tenant {string}',
        async (_c, slug: string) => {
          preRotationUrl = currentUrl;
          rotateRes = await app.request('/api/calendar/feed/rotate', {
            method: 'POST',
            headers: authHeaders(slug),
          });
          if (rotateRes.status === 200) {
            currentUrl = ((await rotateRes.clone().json()) as { url: string }).url;
          }
        },
      );

      Then('the rotate response status is {int}', (_c, n: number) => {
        expect(rotateRes.status).toBe(n);
      });

      When('an anonymous request fetches the pre-rotation subscribe url', async () => {
        const out = await fetchPublicUrl(preRotationUrl);
        publicRes = out.res;
        publicBody = out.body;
      });

      // Its own literal text (not the shared "the public feed response
      // status is {int}" below) — same same-pattern-collision reason as the
      // other scenarios' notes above.
      Then('the pre-rotation public feed response status is {int}', (_c, n: number) => {
        expect(publicRes.status).toBe(n);
      });

      When('an anonymous request fetches that subscribe url', async () => {
        const out = await fetchPublicUrl(currentUrl);
        publicRes = out.res;
        publicBody = out.body;
      });

      Then('the public feed response status is {int}', (_c, n: number) => {
        expect(publicRes.status).toBe(n);
      });
    },
  );

  // ─── Scenario: rotate is admin-only ────────────────────────────────────────

  Scenario('Rotating the feed key is admin-only', ({ Given, When, Then }) => {
    Given(
      'the {string} tenant has a guest member {string}',
      async (_c, slug: string, name: string) => {
        await db.insert(members).values({
          tenantId: tenantIds[slug]!,
          userId: GUEST_USER_ID,
          displayName: name,
          role: 'guest',
        });
      },
    );

    When(
      'a guest caller POSTs /api/calendar/feed/rotate for tenant {string}',
      async (_c, slug: string) => {
        rotateRes = await app.request('/api/calendar/feed/rotate', {
          method: 'POST',
          headers: authHeaders(slug, GUEST_USER_ID),
        });
      },
    );

    Then('the rotate response status is {int}', (_c, n: number) => {
      expect(rotateRes.status).toBe(n);
    });
  });
});
