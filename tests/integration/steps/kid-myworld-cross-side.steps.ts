/**
 * Step bindings for kid-myworld-cross-side.feature (FHS-405).
 *
 * Cross-side consistency: a PARENT write (POST via Supabase-authed routes)
 * must be immediately visible on a KID read (GET via HS256 kid-token routes).
 * Both sides share lib/myworld.ts + the same Postgres rows, so these tests
 * lock that wiring against regressions. Real Postgres throughout.
 *
 * Pattern mirrors kid-reward-requests.steps.ts exactly:
 *  - parentApp: Supabase ES256 JWT + x-test-tenant header
 *  - kidApp:    HS256 kid JWT (scope: child)
 */

import { randomUUID } from 'node:crypto';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { getTestDb } from '../support/db.js';

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
  pinRequestTenant: async () => {},
}));

import { config } from '../../../apps/api/src/config.js';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { kidRouter } from '../../../apps/api/src/routes/kid.js';
import { habitsRouter } from '../../../apps/api/src/routes/habits.js';
import { mwWeeksRouter } from '../../../apps/api/src/routes/mw-weeks.js';
import { mwFinancialRouter } from '../../../apps/api/src/routes/mw-financial.js';
import {
  tenants,
  members,
  habits,
  habitStickers,
  mwWeeks,
  mwSavings,
  users,
} from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';

// ── Constants ────────────────────────────────────────────────────────────────

const KID_ISSUER = 'family-hub-kid-auth';
const SUPA_ISSUER = 'https://test.supabase.local/auth/v1';
const KID_JWK_ID = 'cross-side-int-kid';

// Stable Supabase user id for the admin parent.
const ADMIN_USER_ID = '00000000-0000-4000-8000-000000000405';

// ── Shared state (reset per Background) ─────────────────────────────────────

let db: Database;
let parentApp: Hono; // Supabase auth + tenant header + parent routes
let kidApp: Hono; // kid HS256 routes

let supaPrivateKey: KeyLike;
let supaPublicJwk: JWK;

const ctx: {
  tenantId: string;
  imanId: string;
  habitId: string;
  weekId: string; // the single seeded past week (week 24 / 2026-06-09) used by all scenarios
  adminToken: string;
  imanKidToken: string;
  // per-step response capture
  lastParentStatus: number;
  lastParentBody: Record<string, unknown>;
  lastKidStatus: number;
  lastKidBody: Record<string, unknown>;
} = {} as never;

// ── Key + token helpers (same pattern as kid-reward-requests.steps.ts) ───────

async function genSupaKey() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = 'ES256';
  publicJwk.kid = KID_JWK_ID;
  publicJwk.use = 'sig';
  return { privateKey, publicJwk };
}

async function mintSupaToken(userId: string, email: string): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'ES256', kid: KID_JWK_ID })
    .setSubject(userId)
    .setIssuer(SUPA_ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(supaPrivateKey);
}

function makeJwks(publicJwk: JWK) {
  return async (header: { kid?: string; alg?: string }) => {
    const { importJWK } = await import('jose');
    if (header.kid !== publicJwk.kid) throw new Error(`no key for kid ${header.kid}`);
    return (await importJWK(publicJwk, header.alg ?? 'ES256')) as KeyLike;
  };
}

async function mintKidToken(memberId: string, tenantId: string, slug: string): Promise<string> {
  const secret = new TextEncoder().encode(config.KID_AUTH_SECRET);
  return new SignJWT({ tenantId, tenantSlug: slug, scope: 'child' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(memberId)
    .setIssuer(KID_ISSUER)
    .setExpirationTime('1h')
    .sign(secret);
}

// Middleware that resolves tenantId from a test-only header (mirrors the
// pattern used in kid-reward-requests.steps.ts).
const resolveTenantFromHeader: MiddlewareHandler = async (c, next) => {
  c.set('tenantId', c.req.header('x-test-tenant'));
  await next();
};

function parentHeaders(token: string, tenantId: string) {
  return {
    Authorization: `Bearer ${token}`,
    'x-test-tenant': tenantId,
    'Content-Type': 'application/json',
  };
}

// ── Feature + describeFeature ────────────────────────────────────────────────

const feature = await loadFeature(
  new URL('../features/kid-myworld-cross-side.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  // ── Background ────────────────────────────────────────────────────────────
  Background(({ Given }) => {
    Given(
      'a family with an admin parent and a kid "Iman" set up for cross-side tests',
      async () => {
        db = getTestDb() as unknown as Database;
        await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
        await db.execute(sql`DELETE FROM users WHERE id = ${ADMIN_USER_ID}`);
        _resetJwksCacheForTests();

        // Supabase key + JWKS for parent route auth.
        const k = await genSupaKey();
        supaPrivateKey = k.privateKey;
        supaPublicJwk = k.publicJwk;

        // Users mirror row for the admin parent.
        await db.execute(
          sql`INSERT INTO users (id, email) VALUES (${ADMIN_USER_ID}, 'admin405@example.com')
            ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
        );

        // Seed family: tenant → admin member → kid member.
        const [t] = await db
          .insert(tenants)
          .values({
            slug: `cs-${randomUUID().slice(0, 8)}`,
            name: 'CrossSide Fam',
            currency: 'AED',
          })
          .returning();
        ctx.tenantId = t!.id;

        await db.insert(members).values({
          tenantId: t!.id,
          userId: ADMIN_USER_ID,
          displayName: 'Admin',
          role: 'admin',
        });

        const [iman] = await db
          .insert(members)
          .values({ tenantId: t!.id, displayName: 'Iman', role: 'child', isChild: true })
          .returning();
        ctx.imanId = iman!.id;

        // Seed a habit for Iman (needed for sticker placement + investment).
        const [habit] = await db
          .insert(habits)
          .values({ tenantId: t!.id, memberId: iman!.id, name: 'Read a book', color: '#facc15' })
          .returning();
        ctx.habitId = habit!.id;

        // Seed ONE past week (week 24 / 2026-06-09) used by all five scenarios.
        // Week 24 is the oldest (and only) open week, so getOrCreateCurrentWeek
        // returns it when called without a weekId param: the sticker placed in
        // scenario 1 and the finalize in scenarios 2 & 5 all land here.
        const [stickerWeek] = await db
          .insert(mwWeeks)
          .values({
            tenantId: t!.id,
            memberId: iman!.id,
            weekNumber: 24,
            year: 2026,
            startDate: '2026-06-09',
          })
          .returning();
        ctx.weekId = stickerWeek!.id;

        // Pre-seed 5 unallocated stickers so savings POST (scenario 3) and
        // finalize with auto_save (scenario 5) both have stickers to bank.
        for (const day of [1, 2, 3, 4, 5]) {
          await db.insert(habitStickers).values({
            tenantId: t!.id,
            memberId: iman!.id,
            habitId: habit!.id,
            weekId: stickerWeek!.id,
            day,
            sticker: 'gold-star',
            stickerValue: 1,
          });
        }

        // Pre-seed 20 banked stickers for scenario 4 (investment requires 10
        // minimum and draws from savings first).
        await db.insert(mwSavings).values({
          tenantId: t!.id,
          memberId: iman!.id,
          savedStickers: 20,
        });

        // Mint tokens.
        ctx.adminToken = await mintSupaToken(ADMIN_USER_ID, 'admin405@example.com');
        ctx.imanKidToken = await mintKidToken(iman!.id, t!.id, t!.slug);

        // Parent app: Supabase auth + tenant-from-header + parent routes.
        parentApp = new Hono();
        parentApp.use(
          '*',
          authMiddleware({
            issuer: SUPA_ISSUER,
            jwks: makeJwks(supaPublicJwk),
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
        parentApp.use('*', resolveTenantFromHeader);
        parentApp.route('/api/habits', habitsRouter);
        parentApp.route('/api/mw/weeks', mwWeeksRouter);
        parentApp.route('/api/mw/financial', mwFinancialRouter);

        // Kid app: kid HS256 auth + all kid routes.
        kidApp = new Hono();
        kidApp.route('/api/kid', kidRouter);
      },
    );
  });

  // ── Scenario 1: parent places a sticker, kid sees it ────────────────────
  Scenario('parent places a sticker, kid sees it', ({ When, Then, And }) => {
    When('the admin parent POSTs a sticker for Iman on day 0', async () => {
      const res = await parentApp.request(`/api/habits/${ctx.habitId}/stickers`, {
        method: 'POST',
        headers: parentHeaders(ctx.adminToken, ctx.tenantId),
        body: JSON.stringify({
          memberId: ctx.imanId,
          weekId: ctx.weekId,
          day: 0,
          sticker: 'gold-star',
        }),
      });
      ctx.lastParentStatus = res.status;
      ctx.lastParentBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    });

    Then('the parent sticker response status is 200', () => {
      // POST /api/habits/:id/stickers returns 200: the route does not pass a
      // status argument so Hono defaults to 200.
      expect(ctx.lastParentStatus).toBe(200);
    });

    When('kid "Iman" GETs /api/kid/habits', async () => {
      const res = await kidApp.request('/api/kid/habits', {
        headers: { Authorization: `Bearer ${ctx.imanKidToken}` },
      });
      ctx.lastKidStatus = res.status;
      ctx.lastKidBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    });

    Then('the kid habits response status is 200', () => {
      expect(ctx.lastKidStatus).toBe(200);
    });

    And('the sticker appears in the kid habits response for day 0', () => {
      const stickers = ctx.lastKidBody['stickers'] as Array<{
        habitId: string;
        day: number;
        sticker: string;
      }>;
      expect(Array.isArray(stickers)).toBe(true);
      const placed = stickers.find((s) => s.habitId === ctx.habitId && s.day === 0);
      expect(placed).toBeDefined();
      expect(placed?.sticker).toBe('gold-star');
    });
  });

  // ── Scenario 2: parent finalizes the week, kid sees it finalized ─────────
  Scenario('parent finalizes the week, kid sees it finalized', ({ When, Then, And }) => {
    When("the admin parent finalizes Iman's week", async () => {
      const res = await parentApp.request(`/api/mw/weeks/${ctx.weekId}/finalize`, {
        method: 'POST',
        headers: parentHeaders(ctx.adminToken, ctx.tenantId),
        body: JSON.stringify({ memberId: ctx.imanId }),
      });
      ctx.lastParentStatus = res.status;
      ctx.lastParentBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    });

    Then('the finalize response status is 200', () => {
      expect(ctx.lastParentStatus).toBe(200);
      expect(ctx.lastParentBody['finalized']).toBe(true);
    });

    When('kid "Iman" GETs /api/kid/weeks', async () => {
      const res = await kidApp.request('/api/kid/weeks', {
        headers: { Authorization: `Bearer ${ctx.imanKidToken}` },
      });
      ctx.lastKidStatus = res.status;
      ctx.lastKidBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    });

    Then('the kid cross-side weeks response status is 200', () => {
      expect(ctx.lastKidStatus).toBe(200);
    });

    And("Iman's week is finalized in the kid weeks list", () => {
      const weeks = ctx.lastKidBody['weeks'] as Array<{
        id: string;
        isFinalized: boolean;
        carriedOverStickers: number | null;
      }>;
      expect(Array.isArray(weeks)).toBe(true);
      const targetWeek = weeks.find((w) => w.id === ctx.weekId);
      expect(targetWeek).toBeDefined();
      expect(targetWeek?.isFinalized).toBe(true);
    });
  });

  // ── Scenario 3: parent banks stickers into savings, kid sees the balance ─
  Scenario('parent banks stickers into savings, kid sees the balance', ({ When, Then, And }) => {
    When("the admin parent banks 2 stickers into Iman's savings", async () => {
      const res = await parentApp.request('/api/mw/financial/savings', {
        method: 'POST',
        headers: parentHeaders(ctx.adminToken, ctx.tenantId),
        body: JSON.stringify({ memberId: ctx.imanId, type: 'stickers', amount: 2 }),
      });
      ctx.lastParentStatus = res.status;
      ctx.lastParentBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    });

    Then('the savings POST response status is 201', () => {
      expect(ctx.lastParentStatus).toBe(201);
      expect(ctx.lastParentBody['success']).toBe(true);
    });

    When('kid "Iman" GETs /api/kid/financial/savings', async () => {
      const res = await kidApp.request('/api/kid/financial/savings', {
        headers: { Authorization: `Bearer ${ctx.imanKidToken}` },
      });
      ctx.lastKidStatus = res.status;
      ctx.lastKidBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    });

    Then('the kid cross-side savings response status is 200', () => {
      expect(ctx.lastKidStatus).toBe(200);
    });

    And("Iman's savedStickers reflects the 2 banked stickers", () => {
      // Background seeds 20 saved stickers; banking 2 more from the week
      // brings it to 22. POST /savings draws from week stickers (unallocated)
      // and credits savedStickers, so the kid-visible total must be >= 22.
      const saved = ctx.lastKidBody['savedStickers'] as number;
      expect(typeof saved).toBe('number');
      expect(saved).toBeGreaterThanOrEqual(22);
    });
  });

  // ── Scenario 4: parent creates an investment, kid sees it active ──────────
  Scenario('parent creates an investment, kid sees it active', ({ When, Then, And }) => {
    When('the admin parent creates an investment of 10 stickers for Iman', async () => {
      const res = await parentApp.request('/api/mw/financial/investments', {
        method: 'POST',
        headers: parentHeaders(ctx.adminToken, ctx.tenantId),
        body: JSON.stringify({
          memberId: ctx.imanId,
          habitId: ctx.habitId,
          stickerCount: 10,
          deductible: true,
        }),
      });
      ctx.lastParentStatus = res.status;
      ctx.lastParentBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    });

    Then('the investment POST response status is 201', () => {
      expect(ctx.lastParentStatus).toBe(201);
      expect(typeof ctx.lastParentBody['id']).toBe('string');
      expect(ctx.lastParentBody['isActive']).toBe(true);
    });

    When('kid "Iman" GETs /api/kid/financial/investments', async () => {
      const res = await kidApp.request('/api/kid/financial/investments', {
        headers: { Authorization: `Bearer ${ctx.imanKidToken}` },
      });
      ctx.lastKidStatus = res.status;
      ctx.lastKidBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    });

    Then('the kid cross-side investments response status is 200', () => {
      expect(ctx.lastKidStatus).toBe(200);
    });

    And('the investment is listed as active for Iman', () => {
      const investments = ctx.lastKidBody['investments'] as Array<{
        id: string;
        habitId: string;
        investedStickers: number;
      }>;
      expect(Array.isArray(investments)).toBe(true);
      const inv = investments.find((i) => i.habitId === ctx.habitId);
      expect(inv).toBeDefined();
      expect(inv?.investedStickers).toBe(10);
    });
  });

  // ── Scenario 5: parent finalizes with auto_save, kid reads the action ────
  Scenario(
    'parent finalizes with an auto_save action, kid reads the action',
    ({ When, Then, And }) => {
      When("the admin parent finalizes Iman's sticker week", async () => {
        // Finalize weekId (week 24 / 2026-06-09) which was pre-seeded with 5
        // unallocated stickers in the Background. Finalizing without any
        // investments causes auto_save to bank all unallocated stickers.
        const res = await parentApp.request(`/api/mw/weeks/${ctx.weekId}/finalize`, {
          method: 'POST',
          headers: parentHeaders(ctx.adminToken, ctx.tenantId),
          body: JSON.stringify({ memberId: ctx.imanId }),
        });
        ctx.lastParentStatus = res.status;
        ctx.lastParentBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      });

      Then('the sticker-week finalize response status is 200', () => {
        expect(ctx.lastParentStatus).toBe(200);
        expect(ctx.lastParentBody['finalized']).toBe(true);
        expect(ctx.lastParentBody['stickersAutoSaved']).toBeGreaterThan(0);
      });

      When('kid "Iman" GETs the finalized week\'s actions', async () => {
        const res = await kidApp.request(`/api/kid/weeks/${ctx.weekId}/actions`, {
          headers: { Authorization: `Bearer ${ctx.imanKidToken}` },
        });
        ctx.lastKidStatus = res.status;
        ctx.lastKidBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      });

      Then('the kid cross-side week actions response status is 200', () => {
        expect(ctx.lastKidStatus).toBe(200);
      });

      And('an auto_save action with stickersUsed greater than 0 is present', () => {
        const actions = ctx.lastKidBody['actions'] as Array<{
          actionType: string;
          stickersUsed: number;
        }>;
        expect(Array.isArray(actions)).toBe(true);
        const autoSave = actions.find((a) => a.actionType === 'auto_save');
        expect(autoSave).toBeDefined();
        expect(autoSave!.stickersUsed).toBeGreaterThan(0);
      });
    },
  );
});
