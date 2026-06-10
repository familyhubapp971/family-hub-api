import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { authMiddleware, _resetJwksCacheForTests } from '../../../apps/api/src/middleware/auth.js';
import { dashboardRouter } from '../../../apps/api/src/routes/dashboard.js';
import {
  tenants,
  members,
  habits,
  rewards,
  users,
  tasks,
  savings,
  savingsTransactions,
  activityLogs,
  weeks,
  weekActions,
  mealTemplates,
} from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

// FHS-228 — integration test for GET /api/dashboard/today. Real
// Postgres, real JWT; resolveTenant is stubbed via X-Test-Tenant
// header so each scenario can target a specific tenant — same shape
// as the FHS-108 /api/members test.

vi.mock('../../../apps/api/src/db/client.js', () => ({
  getDb: () => getTestDb(),
}));

const feature = await loadFeature(
  new URL('../features/dashboard.feature', import.meta.url).pathname,
);

const ISSUER = 'https://test.supabase.local/auth/v1';
const KID = 'dashboard-int-kid';
const USER_ID = '00000000-0000-4000-8000-000000000777';
const USER_EMAIL = 'sarah.khan@example.com';

async function genKey() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = 'ES256';
  publicJwk.kid = KID;
  publicJwk.use = 'sig';
  return { privateKey, publicJwk };
}

async function mintToken(privateKey: KeyLike) {
  return new SignJWT({ email: USER_EMAIL })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setSubject(USER_ID)
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
  const tenantId = c.req.header('x-test-tenant');
  c.set('tenantId', tenantId);
  await next();
};

interface DashboardResponse {
  date: string;
  greetingName: string;
  members: Array<{
    id: string;
    displayName: string;
    role: string;
    avatarEmoji: string | null;
    habitsDone: number;
    habitsTotal: number;
    streak: number;
    tasksPending: number;
    statusText: string;
  }>;
  counts: {
    members: number;
    habits: number;
    rewards: number;
    tasksDoneToday: number;
    mealsPlanned: number;
  };
  goals: Array<{ id: string; label: string; progress: number; target: number | null }>;
  recentActivity: Array<{ id: string; actor: string | null; action: string; timestamp: string }>;
}

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  let app: Hono;
  let token: string;
  const tenantIds: Record<string, string> = {};

  Background(({ Given, And }) => {
    Given(
      'the test Postgres has clean tenants, members, habits, rewards, and users tables',
      async () => {
        db = getTestDb() as unknown as Database;
        await db.execute(sql`TRUNCATE TABLE habits RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE rewards RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);
        await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
        await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
        _resetJwksCacheForTests();
        for (const k of Object.keys(tenantIds)) delete tenantIds[k];
      },
    );

    And('a users mirror row exists for the test caller', async () => {
      await db.execute(
        sql`INSERT INTO users (id, email) VALUES (${USER_ID}, ${USER_EMAIL})
            ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      );
      const { privateKey, publicJwk } = await genKey();
      app = new Hono();
      app.use(
        '*',
        authMiddleware({
          issuer: ISSUER,
          jwks: makeJwks(publicJwk),
          userMirrorSync: async () => {
            const rows = await db
              .select()
              .from(users)
              .where(sql`id = ${USER_ID}`)
              .limit(1);
            return rows[0]!;
          },
        }),
      );
      app.use('*', resolveTenantFromHeader);
      app.route('/api/dashboard', dashboardRouter);
      token = await mintToken(privateKey);
    });

    And(
      'a tenant {string} exists with the caller as an admin member',
      async (_ctx, slug: string) => {
        const inserted = await db
          .insert(tenants)
          .values({ slug, name: `${slug} Family` })
          .returning();
        const tenant = inserted[0]!;
        tenantIds[slug] = tenant.id;
        await db.insert(members).values({
          tenantId: tenant.id,
          userId: USER_ID,
          displayName: 'Caller',
          role: 'admin',
        });
      },
    );
  });

  Scenario(
    "Returns greeting, members, and counts for the caller's tenant",
    ({ Given, And, When, Then }) => {
      let res: Response;
      let body: DashboardResponse;

      Given(
        'the {string} tenant has a child member {string} with no linked user',
        async (_ctx, slug: string, name: string) => {
          await db.insert(members).values({
            tenantId: tenantIds[slug]!,
            userId: null,
            displayName: name,
            role: 'child',
          });
        },
      );

      And(
        'the {string} tenant has {int} starter habits and {int} starter rewards',
        async (_ctx, slug: string, habitsN: number, rewardsN: number) => {
          const tenantId = tenantIds[slug]!;
          for (let i = 0; i < habitsN; i++) {
            await db.insert(habits).values({
              tenantId,
              name: `Habit ${i + 1}`,
              cadence: 'daily',
            });
          }
          for (let i = 0; i < rewardsN; i++) {
            await db.insert(rewards).values({
              tenantId,
              name: `Reward ${i + 1}`,
              stickerCost: 5,
            });
          }
        },
      );

      And(
        'the {string} tenant has {int} archived habit and {int} archived reward',
        async (_ctx, slug: string, habitsN: number, rewardsN: number) => {
          const tenantId = tenantIds[slug]!;
          const archivedAt = new Date();
          for (let i = 0; i < habitsN; i++) {
            await db.insert(habits).values({
              tenantId,
              name: `Archived habit ${i + 1}`,
              cadence: 'daily',
              archivedAt,
            });
          }
          for (let i = 0; i < rewardsN; i++) {
            await db.insert(rewards).values({
              tenantId,
              name: `Archived reward ${i + 1}`,
              stickerCost: 5,
              archivedAt,
            });
          }
        },
      );

      When(
        'the caller GETs /api/dashboard/today for tenant {string}',
        async (_ctx, slug: string) => {
          res = await app.request('/api/dashboard/today', {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
              'x-test-tenant': tenantIds[slug]!,
            },
          });
          body = (await res.json()) as DashboardResponse;
        },
      );

      Then('the response status is 200', () => {
        expect(res.status).toBe(200);
      });

      And("the response includes today's date in YYYY-MM-DD form", () => {
        expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });

      And('the response counts are:', (_ctx, dataTables: Array<Record<string, string>>) => {
        for (const row of dataTables) {
          const label = row.label as 'members' | 'habits' | 'rewards';
          const n = Number.parseInt(row.n!, 10);
          expect(body.counts[label], `count for ${label}`).toBe(n);
        }
      });

      And('the response lists {int} members', (_ctx, count: number) => {
        expect(body.members).toHaveLength(count);
      });

      And('the member named {string} appears in the response', (_ctx, name: string) => {
        expect(body.members.find((m) => m.displayName === name)).toBeDefined();
      });
    },
  );

  Scenario(
    'Today screen surfaces per-member stats, goals, and recent activity',
    ({ Given, And, When, Then }) => {
      let res: Response;
      let body: DashboardResponse;
      let callerMemberId: string;
      const habitIds: string[] = [];

      Given(
        'the {string} tenant has {int} starter habits and {int} starter rewards',
        async (_ctx, slug: string, habitsN: number, rewardsN: number) => {
          const tenantId = tenantIds[slug]!;
          for (let i = 0; i < habitsN; i++) {
            const inserted = await db
              .insert(habits)
              .values({ tenantId, name: `Habit ${i + 1}`, cadence: 'daily' })
              .returning();
            habitIds.push(inserted[0]!.id);
          }
          for (let i = 0; i < rewardsN; i++) {
            await db.insert(rewards).values({ tenantId, name: `Reward ${i + 1}`, stickerCost: 5 });
          }
          const callerRows = await db
            .select()
            .from(members)
            .where(sql`tenant_id = ${tenantId} AND user_id = ${USER_ID}`)
            .limit(1);
          callerMemberId = callerRows[0]!.id;
        },
      );

      And(
        'the caller completed both {string} habits in the current week',
        async (_ctx, slug: string) => {
          const tenantId = tenantIds[slug]!;
          const todayIso = new Date().toISOString().slice(0, 10);
          const inserted = await db
            .insert(weeks)
            .values({ tenantId, startDate: todayIso, endDate: todayIso })
            .returning();
          const weekId = inserted[0]!.id;
          for (const habitId of habitIds) {
            await db
              .insert(weekActions)
              .values({ tenantId, weekId, memberId: callerMemberId, habitId, completedCount: 1 });
          }
        },
      );

      And(
        'the caller has 1 pending task and 1 task completed today in {string}',
        async (_ctx, slug: string) => {
          const tenantId = tenantIds[slug]!;
          await db.insert(tasks).values({ tenantId, memberId: callerMemberId, title: 'Pending' });
          await db.insert(tasks).values({
            tenantId,
            memberId: callerMemberId,
            title: 'Done today',
            doneAt: new Date(),
          });
        },
      );

      And(
        'the {string} tenant has a savings goal {string} with a {int} deposit and a {int} withdrawal',
        async (_ctx, slug: string, name: string, deposit: number, withdrawal: number) => {
          const tenantId = tenantIds[slug]!;
          const inserted = await db
            .insert(savings)
            .values({ tenantId, name, targetAmount: '5000.00' })
            .returning();
          const savingsId = inserted[0]!.id;
          const occurredOn = new Date().toISOString().slice(0, 10);
          await db.insert(savingsTransactions).values({
            tenantId,
            savingsId,
            memberId: callerMemberId,
            amount: `${deposit}.00`,
            type: 'deposit',
            occurredOn,
          });
          await db.insert(savingsTransactions).values({
            tenantId,
            savingsId,
            memberId: callerMemberId,
            amount: `${withdrawal}.00`,
            type: 'withdrawal',
            occurredOn,
          });
        },
      );

      And('the {string} tenant has a meal planned for today', async (_ctx, slug: string) => {
        const tenantId = tenantIds[slug]!;
        const todayIso = new Date().toISOString().slice(0, 10);
        const dow = WEEKDAY_KEYS[new Date(`${todayIso}T00:00:00Z`).getUTCDay()]!;
        await db
          .insert(mealTemplates)
          .values({ tenantId, dayOfWeek: dow, slot: 'dinner', name: 'Biryani' });
      });

      // FHS-264 — a per-member meal in the SAME slot as the family meal.
      // mealsPlanned must still count the slot once (distinct slots), not
      // tally both rows.
      And(
        'the {string} tenant has a member meal in the same slot today',
        async (_ctx, slug: string) => {
          const tenantId = tenantIds[slug]!;
          const todayIso = new Date().toISOString().slice(0, 10);
          const dow = WEEKDAY_KEYS[new Date(`${todayIso}T00:00:00Z`).getUTCDay()]!;
          await db.insert(mealTemplates).values({
            tenantId,
            dayOfWeek: dow,
            slot: 'dinner',
            name: 'Kid pasta',
            memberId: callerMemberId,
          });
        },
      );

      And(
        'the {string} tenant has a recent activity entry {string}',
        async (_ctx, slug: string, action: string) => {
          await db
            .insert(activityLogs)
            .values({ tenantId: tenantIds[slug]!, actorMemberId: callerMemberId, action });
        },
      );

      When(
        'the caller GETs /api/dashboard/today for tenant {string}',
        async (_ctx, slug: string) => {
          res = await app.request('/api/dashboard/today', {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
              'x-test-tenant': tenantIds[slug]!,
            },
          });
          body = (await res.json()) as DashboardResponse;
        },
      );

      Then('the response status is 200', () => {
        expect(res.status).toBe(200);
      });

      And("the caller's member stats show 2 of 2 habits done, streak 1, and 1 task pending", () => {
        const caller = body.members.find((m) => m.id === callerMemberId)!;
        expect(caller.habitsDone).toBe(2);
        expect(caller.habitsTotal).toBe(2);
        expect(caller.streak).toBe(1);
        expect(caller.tasksPending).toBe(1);
      });

      And(
        'the response snapshot counts include tasksDoneToday {int} and mealsPlanned {int}',
        (_ctx, done: number, meals: number) => {
          expect(body.counts.tasksDoneToday).toBe(done);
          expect(body.counts.mealsPlanned).toBe(meals);
        },
      );

      And(
        'the response goal {string} shows progress {int} and target {int}',
        (_ctx, label: string, progress: number, target: number) => {
          const goal = body.goals.find((g) => g.label === label)!;
          expect(goal.progress).toBe(progress);
          expect(goal.target).toBe(target);
        },
      );

      And('the response recent activity includes {string}', (_ctx, action: string) => {
        expect(body.recentActivity.find((a) => a.action === action)).toBeDefined();
      });
    },
  );

  Scenario('A non-member of the tenant gets 403', ({ Given, When, Then }) => {
    let res: Response;

    Given(
      'a second tenant {string} exists with no caller membership',
      async (_ctx, slug: string) => {
        const inserted = await db
          .insert(tenants)
          .values({ slug, name: `${slug} Family` })
          .returning();
        tenantIds[slug] = inserted[0]!.id;
      },
    );

    When('the caller GETs /api/dashboard/today for tenant {string}', async (_ctx, slug: string) => {
      res = await app.request('/api/dashboard/today', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-test-tenant': tenantIds[slug]!,
        },
      });
    });

    Then('the response status is 403', () => {
      expect(res.status).toBe(403);
    });
  });

  Scenario(
    'Tenant isolation — counts and members never leak across tenants',
    ({ Given, And, When, Then }) => {
      let res: Response;
      let body: DashboardResponse;

      Given(
        'a second tenant {string} exists with the caller as an admin member',
        async (_ctx, slug: string) => {
          const inserted = await db
            .insert(tenants)
            .values({ slug, name: `${slug} Family` })
            .returning();
          const tenant = inserted[0]!;
          tenantIds[slug] = tenant.id;
          await db.insert(members).values({
            tenantId: tenant.id,
            userId: USER_ID,
            displayName: 'Caller',
            role: 'admin',
          });
        },
      );

      And(
        'the {string} tenant has a child member {string} with no linked user',
        async (_ctx, slug: string, name: string) => {
          await db.insert(members).values({
            tenantId: tenantIds[slug]!,
            userId: null,
            displayName: name,
            role: 'child',
          });
        },
      );

      And(
        'the {string} tenant has {int} starter habits and {int} starter rewards',
        async (_ctx, slug: string, habitsN: number, rewardsN: number) => {
          const tenantId = tenantIds[slug]!;
          for (let i = 0; i < habitsN; i++) {
            await db.insert(habits).values({
              tenantId,
              name: `Habit ${i + 1}`,
              cadence: 'daily',
            });
          }
          for (let i = 0; i < rewardsN; i++) {
            await db.insert(rewards).values({
              tenantId,
              name: `Reward ${i + 1}`,
              stickerCost: 5,
            });
          }
        },
      );

      And(
        'the {string} tenant has a savings goal {string} with a {int} deposit',
        async (_ctx, slug: string, name: string, deposit: number) => {
          const tenantId = tenantIds[slug]!;
          const inserted = await db
            .insert(savings)
            .values({ tenantId, name, targetAmount: '1000.00' })
            .returning();
          await db.insert(savingsTransactions).values({
            tenantId,
            savingsId: inserted[0]!.id,
            amount: `${deposit}.00`,
            type: 'deposit',
            occurredOn: new Date().toISOString().slice(0, 10),
          });
        },
      );

      And(
        'the {string} tenant has a recent activity entry {string}',
        async (_ctx, slug: string, action: string) => {
          // actorMemberId null = a system-logged event in the other tenant.
          await db.insert(activityLogs).values({ tenantId: tenantIds[slug]!, action });
        },
      );

      And(
        'the {string} tenant has 1 task completed today by {string}',
        async (_ctx, slug: string, memberName: string) => {
          const tenantId = tenantIds[slug]!;
          const memberRows = await db
            .select()
            .from(members)
            .where(sql`tenant_id = ${tenantId} AND display_name = ${memberName}`)
            .limit(1);
          await db.insert(tasks).values({
            tenantId,
            memberId: memberRows[0]!.id,
            title: 'Done in smith',
            doneAt: new Date(),
          });
        },
      );

      When(
        'the caller GETs /api/dashboard/today for tenant {string}',
        async (_ctx, slug: string) => {
          res = await app.request('/api/dashboard/today', {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
              'x-test-tenant': tenantIds[slug]!,
            },
          });
          body = (await res.json()) as DashboardResponse;
        },
      );

      Then('the response status is 200', () => {
        expect(res.status).toBe(200);
      });

      And('the response counts are:', (_ctx, dataTables: Array<Record<string, string>>) => {
        for (const row of dataTables) {
          const label = row.label as 'members' | 'habits' | 'rewards';
          const n = Number.parseInt(row.n!, 10);
          expect(body.counts[label], `count for ${label}`).toBe(n);
        }
      });

      And('no member named {string} is in the response', (_ctx, name: string) => {
        expect(body.members.find((m) => m.displayName === name)).toBeUndefined();
      });

      And('the response goals are empty', () => {
        expect(body.goals).toEqual([]);
      });

      And('the response recent activity is empty', () => {
        expect(body.recentActivity).toEqual([]);
      });

      And(
        'the response snapshot counts include tasksDoneToday {int} and mealsPlanned {int}',
        (_ctx, done: number, meals: number) => {
          expect(body.counts.tasksDoneToday).toBe(done);
          expect(body.counts.mealsPlanned).toBe(meals);
        },
      );
    },
  );
});
