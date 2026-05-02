import { randomUUID } from 'node:crypto';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { and, eq, sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { activityLogs, appSettings, members, tenants } from '../../../apps/api/src/db/schema.js';
import type { Database } from '../../../apps/api/src/db/client.js';
import { getTestDb } from '../support/db.js';

const feature = await loadFeature(
  new URL('../features/tenants-content.feature', import.meta.url).pathname,
);

describeFeature(feature, ({ Background, Scenario }) => {
  let db: Database;
  const tenantIds: Record<string, string> = {};

  Background(({ Given, And }) => {
    Given('the test Postgres has clean tenants and content tables', async () => {
      db = getTestDb() as unknown as Database;
      // CASCADE clears app_settings + activity_logs (and the FHS-3 core
      // tables) in one shot via tenant FK chain.
      await db.execute(sql`TRUNCATE TABLE tenants RESTART IDENTITY CASCADE`);
      for (const k of Object.keys(tenantIds)) delete tenantIds[k];
    });

    And('tenants "alpha" and "beta" exist', async () => {
      const [a] = await db
        .insert(tenants)
        .values({ slug: `alpha-${randomUUID().slice(0, 8)}`, name: 'Alpha Family' })
        .returning();
      const [b] = await db
        .insert(tenants)
        .values({ slug: `beta-${randomUUID().slice(0, 8)}`, name: 'Beta Family' })
        .returning();
      tenantIds['alpha'] = a!.id;
      tenantIds['beta'] = b!.id;
    });
  });

  // ─── app_settings ────────────────────────────────────────────────────────

  Scenario('Insert a setting with a jsonb value persists round-trip', ({ When, Then }) => {
    When('I upsert app_setting "theme" with value "\\"dark\\"" in "alpha"', async () => {
      await db
        .insert(appSettings)
        .values({ tenantId: tenantIds['alpha']!, key: 'theme', value: 'dark' });
    });
    Then('the setting is persisted with value "\\"dark\\""', async () => {
      const [row] = await db
        .select()
        .from(appSettings)
        .where(and(eq(appSettings.tenantId, tenantIds['alpha']!), eq(appSettings.key, 'theme')));
      expect(row?.value).toBe('dark');
    });
  });

  Scenario('Composite PK rejects same (tenant_id, key) twice', ({ Given, When, Then }) => {
    let caught: unknown;

    Given('app_setting "theme" exists in "alpha" with value "\\"dark\\""', async () => {
      await db
        .insert(appSettings)
        .values({ tenantId: tenantIds['alpha']!, key: 'theme', value: 'dark' });
    });
    When('I insert app_setting "theme" in "alpha" with value "\\"light\\""', async () => {
      try {
        await db
          .insert(appSettings)
          .values({ tenantId: tenantIds['alpha']!, key: 'theme', value: 'light' });
      } catch (err) {
        caught = err;
      }
    });
    Then('the call rejects with a unique-constraint error', () => {
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message.toLowerCase()).toMatch(/duplicate key|unique constraint|primary key|23505/);
    });
  });

  Scenario('Same key across different tenants is allowed', ({ Given, When, Then }) => {
    Given('app_setting "theme" exists in "alpha" with value "\\"dark\\""', async () => {
      await db
        .insert(appSettings)
        .values({ tenantId: tenantIds['alpha']!, key: 'theme', value: 'dark' });
    });
    When('I insert app_setting "theme" in "beta" with value "\\"light\\""', async () => {
      await db
        .insert(appSettings)
        .values({ tenantId: tenantIds['beta']!, key: 'theme', value: 'light' });
    });
    Then('both rows exist, one per tenant', async () => {
      const { rows } = await db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count FROM app_settings WHERE key = 'theme'`,
      );
      expect(Number(rows[0]?.count ?? 0)).toBe(2);
    });
  });

  Scenario('Setting cascade-deletes when its tenant is deleted', ({ Given, When, Then }) => {
    Given('app_setting "theme" exists in "alpha" with value "\\"dark\\""', async () => {
      await db
        .insert(appSettings)
        .values({ tenantId: tenantIds['alpha']!, key: 'theme', value: 'dark' });
    });
    When('I delete tenant "alpha"', async () => {
      await db.delete(tenants).where(eq(tenants.id, tenantIds['alpha']!));
    });
    Then('no app_settings rows exist for "alpha"', async () => {
      const { rows } = await db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count FROM app_settings WHERE tenant_id = ${tenantIds['alpha']!}`,
      );
      expect(Number(rows[0]?.count ?? 0)).toBe(0);
    });
  });

  // ─── activity_logs ───────────────────────────────────────────────────────

  Scenario(
    'Insert an activity log with all actor fields populated',
    ({ Given, When, Then, And }) => {
      let memberId: string;

      Given('a member exists in "alpha"', async () => {
        const [m] = await db
          .insert(members)
          .values({ tenantId: tenantIds['alpha']!, displayName: 'Yusuf' })
          .returning();
        memberId = m!.id;
      });
      When('I log action "habit.completed" attributed to that member', async () => {
        await db.insert(activityLogs).values({
          tenantId: tenantIds['alpha']!,
          actorMemberId: memberId,
          action: 'habit.completed',
          targetType: 'habit',
          targetId: randomUUID(),
          metadata: { count: 1 },
        });
      });
      Then('exactly 1 activity_logs row exists for "alpha"', async () => {
        const { rows } = await db.execute<{ count: string }>(
          sql`SELECT COUNT(*)::text AS count FROM activity_logs WHERE tenant_id = ${tenantIds['alpha']!}`,
        );
        expect(Number(rows[0]?.count ?? 0)).toBe(1);
      });
      And('the row has the actor_member_id set', async () => {
        const [row] = await db
          .select()
          .from(activityLogs)
          .where(eq(activityLogs.tenantId, tenantIds['alpha']!));
        expect(row?.actorMemberId).toBe(memberId);
      });
    },
  );

  Scenario('System action (no actor) is allowed', ({ When, Then, And }) => {
    When('I log action "system.nightly.recompute" with no actor in "alpha"', async () => {
      await db.insert(activityLogs).values({
        tenantId: tenantIds['alpha']!,
        action: 'system.nightly.recompute',
      });
    });
    Then('exactly 1 activity_logs row exists for "alpha"', async () => {
      const { rows } = await db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count FROM activity_logs WHERE tenant_id = ${tenantIds['alpha']!}`,
      );
      expect(Number(rows[0]?.count ?? 0)).toBe(1);
    });
    And('the row has both actor_member_id and actor_user_id null', async () => {
      const [row] = await db
        .select()
        .from(activityLogs)
        .where(eq(activityLogs.tenantId, tenantIds['alpha']!));
      expect(row?.actorMemberId).toBeNull();
      expect(row?.actorUserId).toBeNull();
    });
  });

  Scenario(
    'Actor member deletion preserves the audit trail (SET NULL)',
    ({ Given, And, When, Then }) => {
      let memberId: string;

      Given('a member exists in "alpha"', async () => {
        const [m] = await db
          .insert(members)
          .values({ tenantId: tenantIds['alpha']!, displayName: 'Yusuf' })
          .returning();
        memberId = m!.id;
      });
      And('an activity log records that member doing "habit.completed"', async () => {
        await db.insert(activityLogs).values({
          tenantId: tenantIds['alpha']!,
          actorMemberId: memberId,
          action: 'habit.completed',
        });
      });
      When('I delete that member', async () => {
        await db.delete(members).where(eq(members.id, memberId));
      });
      Then('the activity_logs row still exists', async () => {
        const { rows } = await db.execute<{ count: string }>(
          sql`SELECT COUNT(*)::text AS count FROM activity_logs WHERE tenant_id = ${tenantIds['alpha']!}`,
        );
        expect(Number(rows[0]?.count ?? 0)).toBe(1);
      });
      And("the row's actor_member_id is null", async () => {
        const [row] = await db
          .select()
          .from(activityLogs)
          .where(eq(activityLogs.tenantId, tenantIds['alpha']!));
        expect(row?.actorMemberId).toBeNull();
      });
    },
  );

  Scenario('Activity logs cascade-delete with tenant', ({ Given, When, Then }) => {
    Given('an activity log exists in "alpha"', async () => {
      await db.insert(activityLogs).values({
        tenantId: tenantIds['alpha']!,
        action: 'tenant.created',
      });
    });
    When('I delete tenant "alpha"', async () => {
      await db.delete(tenants).where(eq(tenants.id, tenantIds['alpha']!));
    });
    Then('no activity_logs rows exist for "alpha"', async () => {
      const { rows } = await db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count FROM activity_logs WHERE tenant_id = ${tenantIds['alpha']!}`,
      );
      expect(Number(rows[0]?.count ?? 0)).toBe(0);
    });
  });
});
